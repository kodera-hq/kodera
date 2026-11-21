"""Real signed HTTP admission, contract responses and replay disclosure checks."""

import hashlib
import json
import secrets
from uuid import uuid4

import pytest
from customer_http_fixtures import http_signer as http_signer
from django.db import transaction
from django.test import override_settings
from test_access_tokens import frozen_clock as frozen_clock
from test_workspace_onboarding import call
from workspace_safety.test_moderation import world as world
from workspace_safety.test_moderation_http import http as http

from apps.identity.models import Identity
from apps.media.models import Attachment
from apps.notifications import push, services as notifications
from apps.notifications.models import PushSubscription
from workspace_media.test_media_services import gateway as gateway
from workspace_media.test_notification_services import configured as configured

pytestmark = pytest.mark.django_db(transaction=True)


def headers(token):
    return {"HTTP_AUTHORIZATION": "Bearer " + token, "HTTP_IDEMPOTENCY_KEY": str(uuid4())}


@override_settings(ROOT_URLCONF="apps.media.api.urls")
def test_upload_replay_and_completed_metadata_follow_the_contract(world, http, gateway):
    from apps.workspaces.models import Channel, ResourcePolicy

    org, workspace, members, _ = world
    client, credentials = http
    policy = ResourcePolicy.objects.create(workspace=workspace, visibility="organisation")
    channel = Channel.objects.create(
        workspace=workspace,
        name="Uploads",
        kind="text",
        lifecycle="active",
        position=0,
        policy_mode="explicit",
        explicit_policy=policy,
    )
    root = f"/api/v1/organisations/{org.id}/workspace/attachments"
    unscoped = client.post(
        root + "/uploads",
        data=json.dumps(
            {
                "filename": "example.txt",
                "contentType": "text/plain",
                "sizeBytes": 42,
                "sha256": hashlib.sha256(secrets.token_bytes(42)).hexdigest(),
            }
        ),
        content_type="application/json",
        **headers(credentials[3]),
    )
    assert unscoped.status_code == 422
    data = json.dumps(
        {
            "filename": "example.txt",
            "contentType": "text/plain",
            "sizeBytes": 42,
            "sha256": hashlib.sha256(secrets.token_bytes(42)).hexdigest(),
            "channelId": str(channel.id),
        }
    )
    auth = headers(credentials[3])
    first = client.post(root + "/uploads", data=data, content_type="application/json", **auth)
    call(first, "/organisations/{organisation_id}/workspace/attachments/uploads", "post")
    assert first.status_code == 201
    replay = client.post(root + "/uploads", data=data, content_type="application/json", **auth)
    assert replay["Idempotency-Replayed"] == "true" and replay.json() == first.json()
    assert Attachment.objects.count() == 1 and len(gateway.calls) == 1
    identifier = first.json()["attachmentId"]
    completed = client.post(
        root + "/" + identifier + "/complete",
        data=b"",
        content_type="application/json",
        **headers(credentials[3]),
    )
    call(
        completed,
        "/organisations/{organisation_id}/workspace/attachments/{attachment_id}/complete",
        "post",
    )
    assert completed.status_code == 200 and completed.json()["disposition"] == "attachment"
    read = client.get(root + "/" + identifier, HTTP_AUTHORIZATION="Bearer " + credentials[2])
    call(read, "/organisations/{organisation_id}/workspace/attachments/{attachment_id}", "get")
    assert read.status_code == 200 and read["Cache-Control"] == "no-store"
    Identity.objects.filter(user_id=members[3].user_id).update(enabled=False)
    revoked = client.post(root + "/uploads", data=data, content_type="application/json", **auth)
    assert revoked.status_code == 403 and "uploadUrl" not in revoked.content.decode()


@override_settings(ROOT_URLCONF="apps.media.api.urls")
def test_scoped_upload_and_cancel_endpoint_enforce_scope_and_delete_ticket(world, http, gateway):
    from test_workspace_onboarding import contract

    from apps.workspaces.models import Channel, ResourcePolicy

    org, workspace, _, _ = world
    client, credentials = http
    policy = ResourcePolicy.objects.create(workspace=workspace, visibility="organisation")
    channel = Channel.objects.create(
        workspace=workspace,
        name="General",
        kind="text",
        lifecycle="active",
        position=0,
        policy_mode="explicit",
        explicit_policy=policy,
    )
    root = f"/api/v1/organisations/{org.id}/workspace/attachments"
    payload = json.dumps(
        {
            "filename": "draft.txt",
            "contentType": "text/plain",
            "sizeBytes": 24,
            "sha256": hashlib.sha256(b"draft-payload-24-bytes!!").hexdigest(),
            "channelId": str(channel.id),
        }
    )
    created = client.post(
        root + "/uploads",
        data=payload,
        content_type="application/json",
        **headers(credentials[3]),
    )
    call(created, "/organisations/{organisation_id}/workspace/attachments/uploads", "post")
    assert created.status_code == 201
    attachment_id = created.json()["attachmentId"]
    assert Attachment.objects.get(pk=attachment_id).channel_id == channel.id

    forbidden = client.delete(
        root + "/" + attachment_id,
        HTTP_AUTHORIZATION="Bearer " + credentials[2],
    )
    assert forbidden.status_code == 403
    assert Attachment.objects.filter(pk=attachment_id).exists()

    deleted = client.delete(
        root + "/" + attachment_id,
        HTTP_AUTHORIZATION="Bearer " + credentials[3],
    )
    template = "/organisations/{organisation_id}/workspace/attachments/{attachment_id}"
    if "delete" in contract()["paths"].get(template, {}):
        call(deleted, template, "delete")
    assert deleted.status_code == 204 and deleted.content == b""
    assert "X-Request-Id" in deleted.headers
    tombstone = Attachment.objects.get(pk=attachment_id)
    assert tombstone.cancelled_at is not None and tombstone.completed_at is None
    fenced_complete = client.post(
        root + "/" + attachment_id + "/complete",
        data=b"",
        content_type="application/json",
        **headers(credentials[3]),
    )
    assert fenced_complete.status_code == 409


@override_settings(ROOT_URLCONF="apps.media.api.urls")
def test_metadata_target_unfurl_refuses_without_a_network_connection(world, http):
    org, _, _, _ = world
    client, credentials = http
    response = client.post(
        f"/api/v1/organisations/{org.id}/workspace/unfurl",
        data=json.dumps({"url": "http://169.254.169.254/latest/"}),
        content_type="application/json",
        **headers(credentials[3]),
    )
    call(response, "/organisations/{organisation_id}/workspace/unfurl", "post")
    assert response.status_code == 403 and response.json()["reason"] == "private-target"


@override_settings(ROOT_URLCONF="apps.notifications.api.urls")
def test_inbox_and_device_endpoints_follow_the_contract(world, http, configured):
    from cryptography.hazmat.primitives.asymmetric import ec

    org, _, members, _ = world
    client, credentials = http
    auth = headers(credentials[3])
    with transaction.atomic():
        entry = notifications.record(
            organisation_id=org.id,
            membership_id=members[3].id,
            kind="moderation",
            resource_id=members[3].id,
        )
    response = client.get("/api/v1/notifications", **auth)
    call(response, "/notifications", "get")
    assert response.status_code == 200 and response.json()["data"][0]["id"] == str(entry.id)
    response = client.post(
        "/api/v1/notifications/read",
        data=json.dumps({"ids": [str(entry.id)]}),
        content_type="application/json",
        **auth,
    )
    call(response, "/notifications/read", "post")
    assert response.status_code == 204
    response = client.get("/api/v1/push/public-key", **auth)
    call(response, "/push/public-key", "get")
    assert response.status_code == 200 and response.json()["payloadMode"] == "empty"
    device = uuid4()
    body = json.dumps(
        {
            "endpoint": "https://push.example.org/wake",
            "p256dh": push.public_key(ec.generate_private_key(ec.SECP256R1())),
            "auth": push.encode(secrets.token_bytes(16)),
        }
    )
    path = f"/api/v1/push/subscriptions/{device}"
    response = client.put(path, data=body, content_type="application/json", **auth)
    call(response, "/push/subscriptions/{device_id}", "put")
    assert response.status_code == 204
    row = PushSubscription.objects.get(device_id=device)
    version = row.version
    assert client.put(path, data=body, content_type="application/json", **auth).status_code == 204
    row.refresh_from_db()
    assert row.version == version
    assert client.delete(path, HTTP_AUTHORIZATION="Bearer " + credentials[2]).status_code == 204
    row.refresh_from_db()
    assert row.revoked_at is None
    response = client.delete(path, **auth)
    call(response, "/push/subscriptions/{device_id}", "delete")
    assert response.status_code == 204
    row.refresh_from_db()
    assert row.revoked_at is not None
