"""Active-presence mobile push suppression, v1/v2 AAD binding, writer role and HTTP contract."""

from __future__ import annotations

import hashlib
import json
import secrets
from datetime import timedelta
from uuid import uuid4

import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from customer_http_fixtures import http_signer as http_signer
from django.db import IntegrityError, transaction
from django.test import override_settings
from django.utils import timezone
from test_access_tokens import frozen_clock as frozen_clock
from test_intake_writer_role import INSUFFICIENT_PRIVILEGE, acting_as, refused
from test_workspace_onboarding import call
from test_workspace_writer_role import _role
from workspace_safety.test_moderation import world as world
from workspace_safety.test_moderation_http import http as http

from apps.media.context import RefusalError
from apps.notifications import dispatcher, push, services as service
from apps.notifications.models import Notification, PresenceLease, PushOutbox, PushSubscription
from core import sealing
from workspace_media.test_notification_services import configured as configured

pytestmark = pytest.mark.django_db


def _subscription_payload(endpoint: str, *, platform: str | None = None) -> dict[str, str]:
    body = {
        "endpoint": endpoint,
        "p256dh": push.public_key(ec.generate_private_key(ec.SECP256R1())),
        "auth": push.encode(secrets.token_bytes(16)),
    }
    if platform is not None:
        body["platform"] = platform
    return body


def _register_device(world, endpoint: str, *, platform: str | None = None) -> PushSubscription:
    _, _, _, tokens = world
    dev_id = uuid4()
    service.put_subscription(
        verified=tokens[3],
        device_id=dev_id,
        body=_subscription_payload(endpoint, platform=platform),
        request_id=str(uuid4()),
    )
    return PushSubscription.objects.get(device_id=dev_id)


def _emit_notification(world, recipient: int = 3) -> Notification:
    org, _, members, _ = world
    with transaction.atomic():
        return service.record(
            organisation_id=org.id,
            membership_id=members[recipient].id,
            kind="moderation",
            resource_id=members[recipient].id,
        )


def test_v1_unseal_fallback_for_web_and_v2_aad_platform_binding_refuses_tampering(
    world, configured, settings
):
    org, _, members, _ = world
    key = settings.KODERA_NOTIFICATION_SEAL_KEY
    material = {
        "endpoint": "https://push.example.org/legacy-v1",
        "p256dh": push.public_key(ec.generate_private_key(ec.SECP256R1())),
        "auth": push.encode(secrets.token_bytes(16)),
    }
    legacy_row = PushSubscription(
        organisation=org,
        membership=members[3],
        device_id=uuid4(),
        platform="web",
        version=uuid4(),
        endpoint_digest=hashlib.sha256(material["endpoint"].encode()).hexdigest(),
    )
    legacy_row.sealed_subscription = sealing.seal(
        key,
        service.associated_v1(legacy_row),
        json.dumps(material, separators=(",", ":")).encode(),
    )
    legacy_row.save(force_insert=True)

    # Pre-existing v1 web subscription unseals seamlessly.
    assert service.subscription_data(legacy_row) == material

    # Rewriting platform on a v1 row cannot bypass v2 platform AAD binding.
    for forged_platform in ("ios", "android", "desktop"):
        legacy_row.platform = forged_platform
        with pytest.raises(RefusalError) as err:
            service.subscription_data(legacy_row)
        assert err.value.status == 503

    # v2 row binds platform in AAD; tampering platform fails closed.
    ios_row = _register_device(world, "https://push.example.org/v2-ios", platform="ios")
    assert ios_row.platform == "ios"
    unsealed_ios = service.subscription_data(ios_row)
    assert unsealed_ios["endpoint"] == "https://push.example.org/v2-ios"

    ios_row.platform = "web"
    with pytest.raises(RefusalError) as err2:
        service.subscription_data(ios_row)
    assert err2.value.status == 503


def test_active_presence_suppresses_mobile_wakeups_while_creating_inbox_and_auto_resumes(
    world, configured
):
    _, _, _, tokens = world
    web_sub = _register_device(world, "https://push.example.org/dev-web")
    desktop_sub = _register_device(
        world, "https://push.example.org/dev-desktop", platform="desktop"
    )
    ios_sub = _register_device(world, "https://push.example.org/dev-ios", platform="ios")
    android_sub = _register_device(
        world, "https://push.example.org/dev-android", platform="android"
    )
    assert web_sub.platform == "web"

    desktop_device = uuid4()
    lease_resp = service.put_presence(
        verified=tokens[3],
        device_id=desktop_device,
        body={"platform": "desktop", "ttlSeconds": 60},
        request_id=str(uuid4()),
    )
    assert lease_resp["platform"] == "desktop"
    assert lease_resp["ttlSeconds"] == 60

    # 1) Active desktop lease: Notification inbox row IS created, web/desktop wakeups enqueue,
    #    while ios/android wakeups are suppressed.
    first_note = _emit_notification(world)
    inbox_page = service.inbox(verified=tokens[3], cursor=None, limit=10)
    assert [item["id"] for item in inbox_page["data"]] == [str(first_note.id)]
    enqueued_sub_ids = set(PushOutbox.objects.values_list("subscription_id", flat=True))
    assert enqueued_sub_ids == {web_sub.id, desktop_sub.id}
    assert ios_sub.id not in enqueued_sub_ids
    assert android_sub.id not in enqueued_sub_ids

    # 2) Lease expires without explicit DELETE (client disconnected/crashed): mobile push resumes!
    PushOutbox.objects.all().delete()
    expired_time = timezone.now() - timedelta(seconds=5)
    PresenceLease.objects.filter(device_id=desktop_device).update(
        updated_at=expired_time - timedelta(seconds=60),
        expires_at=expired_time,
    )
    second_note = _emit_notification(world)
    inbox_after_expiry = service.inbox(verified=tokens[3], cursor=None, limit=10)
    assert len(inbox_after_expiry["data"]) == 2
    assert inbox_after_expiry["data"][0]["id"] == str(second_note.id)
    resumed_sub_ids = set(PushOutbox.objects.values_list("subscription_id", flat=True))
    assert resumed_sub_ids == {web_sub.id, desktop_sub.id, ios_sub.id, android_sub.id}

    # 3) Explicit web lease renewal suppresses mobile again; delete_presence resumes immediately.
    PushOutbox.objects.all().delete()
    web_device = uuid4()
    service.put_presence(
        verified=tokens[3],
        device_id=web_device,
        body={"platform": "web", "ttlSeconds": 90},
        request_id=str(uuid4()),
    )
    _emit_notification(world)
    assert set(PushOutbox.objects.values_list("subscription_id", flat=True)) == {
        web_sub.id,
        desktop_sub.id,
    }

    PushOutbox.objects.all().delete()
    service.delete_presence(verified=tokens[3], device_id=web_device, request_id=str(uuid4()))
    _emit_notification(world)
    assert set(PushOutbox.objects.values_list("subscription_id", flat=True)) == {
        web_sub.id,
        desktop_sub.id,
        ios_sub.id,
        android_sub.id,
    }


def test_dispatcher_marks_queued_mobile_wakeup_obsolete_when_presence_activates_without_revoking(
    world, configured, monkeypatch
):
    _, _, _, tokens = world
    web_sub = _register_device(world, "https://push.example.org/q-web", platform="web")
    ios_sub = _register_device(world, "https://push.example.org/q-ios", platform="ios")
    android_sub = _register_device(world, "https://push.example.org/q-android", platform="android")

    # Notification arrives while offline -> all 3 outbox wakeups are queued.
    _emit_notification(world)
    assert PushOutbox.objects.filter(state="pending").count() == 3

    # Before dispatcher claims them, member becomes active on web.
    service.put_presence(
        verified=tokens[3],
        device_id=uuid4(),
        body={"platform": "web", "ttlSeconds": 45},
        request_id=str(uuid4()),
    )

    delivered_endpoints: list[str] = []
    monkeypatch.setattr(
        push,
        "send",
        lambda endpoint, *_args: delivered_endpoints.append(endpoint) or push.Result("delivered"),
    )

    while dispatcher.dispatch_one(configured, "mailto:operations@example.org"):
        pass

    assert delivered_endpoints == ["https://push.example.org/q-web"]
    assert PushOutbox.objects.get(subscription=web_sub).state == "delivered"
    assert PushOutbox.objects.get(subscription=ios_sub).state == "obsolete"
    assert PushOutbox.objects.get(subscription=android_sub).state == "obsolete"

    # Mobile subscriptions MUST NOT be revoked when suppressed as obsolete.
    ios_sub.refresh_from_db()
    android_sub.refresh_from_db()
    assert ios_sub.revoked_at is None
    assert android_sub.revoked_at is None


@pytest.mark.django_db(transaction=True)
@override_settings(ROOT_URLCONF="apps.notifications.api.urls")
def test_presence_http_contract_db_constraints_and_api_writer_role(world, http, configured):
    org, _ws, members, tokens = world
    client, credentials = http
    auth = {"HTTP_AUTHORIZATION": "Bearer " + credentials[3]}

    mobile_dev = uuid4()
    sub_resp = client.put(
        f"/api/v1/push/subscriptions/{mobile_dev}",
        data=json.dumps(_subscription_payload("https://push.example.org/http-ios", platform="ios")),
        content_type="application/json",
        **auth,
    )
    call(sub_resp, "/push/subscriptions/{device_id}", "put")
    assert sub_resp.status_code == 204
    assert PushSubscription.objects.get(device_id=mobile_dev).platform == "ios"

    presence_dev = uuid4()
    put_ok = client.put(
        f"/api/v1/notifications/presence/{presence_dev}",
        data=json.dumps({"platform": "desktop", "ttlSeconds": 60}),
        content_type="application/json",
        **auth,
    )
    call(put_ok, "/notifications/presence/{device_id}", "put")
    assert put_ok.status_code == 200
    assert put_ok.json()["platform"] == "desktop"
    assert put_ok.json()["ttlSeconds"] == 60

    # Rejects TTL > 90s, TTL <= 0, non-int TTL, and mobile platform on foreground presence.
    for invalid_body in (
        {"platform": "desktop", "ttlSeconds": 91},
        {"platform": "desktop", "ttlSeconds": 0},
        {"platform": "desktop", "ttlSeconds": True},
        {"platform": "ios", "ttlSeconds": 60},
    ):
        bad = client.put(
            f"/api/v1/notifications/presence/{presence_dev}",
            data=json.dumps(invalid_body),
            content_type="application/json",
            **auth,
        )
        assert bad.status_code == 422

    del_ok = client.delete(f"/api/v1/notifications/presence/{presence_dev}", **auth)
    call(del_ok, "/notifications/presence/{device_id}", "delete")
    assert del_ok.status_code == 204
    assert not PresenceLease.objects.filter(device_id=presence_dev).exists()

    # PostgreSQL check constraint refuses > 90s TTL even on direct ORM insert.
    with pytest.raises(IntegrityError), transaction.atomic():
        PresenceLease.objects.create(
            organisation=org,
            membership=members[3],
            device_id=uuid4(),
            platform="web",
            expires_at=timezone.now() + timedelta(seconds=95),
        )

    # Restricted `kodera_api` writer role permits lease renewal/deletion and blocks binding tampering.
    role_gen = _role()
    writer = next(role_gen)
    try:
        with acting_as(writer):
            writer_dev = uuid4()
            service.put_presence(
                verified=tokens[3],
                device_id=writer_dev,
                body={"platform": "web", "ttlSeconds": 30},
                request_id=str(uuid4()),
            )
            service.put_presence(
                verified=tokens[3],
                device_id=writer_dev,
                body={"platform": "desktop", "ttlSeconds": 75},
                request_id=str(uuid4()),
            )
            assert (
                refused("UPDATE notifications_presencelease SET device_id = gen_random_uuid()")
                == INSUFFICIENT_PRIVILEGE
            )
            assert (
                refused("UPDATE notifications_presencelease SET membership_id = membership_id")
                == INSUFFICIENT_PRIVILEGE
            )
            service.delete_presence(
                verified=tokens[3], device_id=writer_dev, request_id=str(uuid4())
            )
    finally:
        with pytest.raises(StopIteration):
            next(role_gen)
