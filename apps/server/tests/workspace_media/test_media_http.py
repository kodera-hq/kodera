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


@override_settings(ROOT_URLCONF="apps.media.api.urls")
def test_http_complete_and_replay_enforce_live_dm_and_channel_scope(world, http, gateway, settings):
    import threading
    import urllib.parse
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    from apps.workspaces.models import Channel, ResourcePolicy, ResourcePolicyRule
    from config.workspace_features import media_room_verifier_url
    from room_access.clients import LiveKit, Matrix
    from room_access.server import make_webhook_server

    org, workspace, members, tokens = world
    client, credentials = http

    matrix_domain = "matrix.kodera.test"
    agent_mxid = f"@kodera-agent:{matrix_domain}"
    room_access_token = "room-access-nonadmin-" + secrets.token_hex(8)
    dm_room = f"!dmHttpScopeRoom:{matrix_domain}"
    uploader_mxid = f"@{tokens[3].subject.lower()}:{matrix_domain}"
    dm_joined_mxids = {uploader_mxid}

    class FakeSynapseHandler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            if self.headers.get("Authorization") != f"Bearer {room_access_token}":
                self._json(401, {"errcode": "M_UNKNOWN_TOKEN"})
                return
            parsed = urllib.parse.urlsplit(self.path)
            if parsed.path.startswith("/_synapse/admin/") or parsed.path.endswith(
                "/joined_members"
            ):
                # Shipped room-access holds a non-admin occupancy account and never joins DMs.
                self._json(403, {"errcode": "M_FORBIDDEN"})
                return
            if parsed.path == "/_synapse/client/kodera/v1/dm_member":
                params = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
                target_room = params.get("room_id", [""])[0]
                target_user = params.get("user_id", [""])[0]
                joined = target_room == dm_room and target_user in dm_joined_mxids
                self._json(200, {"joined": joined})
                return
            self._json(404, {"errcode": "M_NOT_FOUND"})

        def _json(self, status: int, payload: dict) -> None:
            raw = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            return

    synapse_srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeSynapseHandler)
    threading.Thread(target=synapse_srv.serve_forever, daemon=True).start()
    room_access_srv = make_webhook_server(
        "127.0.0.1",
        0,
        LiveKit("http://127.0.0.1:9", "lk-key", "lk-secret-" + "x" * 32),
        lambda _ev: None,
        matrix=Matrix(
            f"http://127.0.0.1:{synapse_srv.server_address[1]}", room_access_token, timeout=2.0
        ),
        agent_user=agent_mxid,
    )
    threading.Thread(target=room_access_srv.serve_forever, daemon=True).start()
    settings.KODERA_MEDIA_ROOM_VERIFIER_URL = media_room_verifier_url(
        {
            "KODERA_MEDIA_ROOM_VERIFIER_URL": (
                f"http://127.0.0.1:{room_access_srv.server_address[1]}/internal/room-member"
            )
        }
    )

    try:
        root = f"/api/v1/organisations/{org.id}/workspace/attachments"
        dm_upload_body = json.dumps(
            {
                "filename": "dm-secret.txt",
                "contentType": "text/plain",
                "sizeBytes": 32,
                "sha256": hashlib.sha256(b"dm-secret-32-byte-body-payload!!").hexdigest(),
                "roomId": dm_room,
            }
        )
        dm_upload_auth = headers(credentials[3])
        dm_created = client.post(
            root + "/uploads",
            data=dm_upload_body,
            content_type="application/json",
            **dm_upload_auth,
        )
        assert dm_created.status_code == 201
        dm_id = dm_created.json()["attachmentId"]

        # 1. Prepared HTTP completion re-checks DM membership after download presigning
        gateway.hooks["download"] = lambda _obj: dm_joined_mxids.discard(uploader_mxid)
        mid_presign_revoked = client.post(
            f"{root}/{dm_id}/complete",
            data=b"",
            content_type="application/json",
            **headers(credentials[3]),
        )
        assert mid_presign_revoked.status_code == 403
        assert "downloadUrl" not in mid_presign_revoked.content.decode()
        gateway.hooks.pop("download", None)
        dm_joined_mxids.add(uploader_mxid)

        # 2. Successful HTTP completion caches response, and replay after DM removal returns 403
        dm_complete_auth = headers(credentials[3])
        dm_completed = client.post(
            f"{root}/{dm_id}/complete",
            data=b"",
            content_type="application/json",
            **dm_complete_auth,
        )
        assert dm_completed.status_code == 200 and "downloadUrl" in dm_completed.json()
        dm_replay_ok = client.post(
            f"{root}/{dm_id}/complete",
            data=b"",
            content_type="application/json",
            **dm_complete_auth,
        )
        assert dm_replay_ok.status_code == 200 and dm_replay_ok["Idempotency-Replayed"] == "true"

        dm_joined_mxids.discard(uploader_mxid)
        dm_upload_replay_denied = client.post(
            root + "/uploads",
            data=dm_upload_body,
            content_type="application/json",
            **dm_upload_auth,
        )
        assert dm_upload_replay_denied.status_code == 403
        assert "uploadUrl" not in dm_upload_replay_denied.content.decode()

        dm_complete_replay_denied = client.post(
            f"{root}/{dm_id}/complete",
            data=b"",
            content_type="application/json",
            **dm_complete_auth,
        )
        assert dm_complete_replay_denied.status_code == 403
        assert "downloadUrl" not in dm_complete_replay_denied.content.decode()

        # 3. Private channel scope loss also blocks cached upload and completion replays
        listed_policy = ResourcePolicy.objects.create(workspace=workspace, visibility="restricted")
        rule = ResourcePolicyRule.objects.create(
            policy=listed_policy,
            kind="allow_member",
            membership=members[3],
        )
        private_channel = Channel.objects.create(
            workspace=workspace,
            name="Restricted Replay Check",
            kind="text",
            lifecycle="active",
            position=9,
            policy_mode="explicit",
            explicit_policy=listed_policy,
        )
        chan_body = json.dumps(
            {
                "filename": "restricted.txt",
                "contentType": "text/plain",
                "sizeBytes": 28,
                "sha256": hashlib.sha256(b"restricted-28-byte-payload!!").hexdigest(),
                "channelId": str(private_channel.id),
            }
        )
        chan_upload_auth = headers(credentials[3])
        chan_created = client.post(
            root + "/uploads",
            data=chan_body,
            content_type="application/json",
            **chan_upload_auth,
        )
        assert chan_created.status_code == 201
        chan_att_id = chan_created.json()["attachmentId"]

        chan_complete_auth = headers(credentials[3])
        chan_completed = client.post(
            f"{root}/{chan_att_id}/complete",
            data=b"",
            content_type="application/json",
            **chan_complete_auth,
        )
        assert chan_completed.status_code == 200

        rule.delete()
        chan_upload_replay_denied = client.post(
            root + "/uploads",
            data=chan_body,
            content_type="application/json",
            **chan_upload_auth,
        )
        assert chan_upload_replay_denied.status_code == 403
        assert "uploadUrl" not in chan_upload_replay_denied.content.decode()

        chan_complete_replay_denied = client.post(
            f"{root}/{chan_att_id}/complete",
            data=b"",
            content_type="application/json",
            **chan_complete_auth,
        )
        assert chan_complete_replay_denied.status_code == 403
        assert "downloadUrl" not in chan_complete_replay_denied.content.decode()
    finally:
        gateway.hooks.pop("download", None)
        room_access_srv.shutdown()
        room_access_srv.server_close()
        synapse_srv.shutdown()
        synapse_srv.server_close()


@override_settings(ROOT_URLCONF="apps.media.api.urls")
def test_http_dm_completion_holds_zero_workspace_or_attachment_locks_during_verifier_io(
    world, http, gateway, settings
):
    import queue
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from typing import Any

    from django.db import connections
    from django.test import Client

    from apps.workspaces.models import Workspace
    from config.workspace_features import media_room_verifier_url

    org, workspace, _, _ = world
    client, credentials = http
    dm_room = "!" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1_"
    pauses: queue.Queue[threading.Event] = queue.Queue()
    intercept = threading.Event()

    class PausingVerifierHandler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            length = int(self.headers.get("Content-Length", "0"))
            _ = self.rfile.read(length)
            if intercept.is_set():
                resume = threading.Event()
                pauses.put(resume)
                assert resume.wait(timeout=5.0)
            raw = b'{"allowed":true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            return

    verifier_srv = ThreadingHTTPServer(("127.0.0.1", 0), PausingVerifierHandler)
    threading.Thread(target=verifier_srv.serve_forever, daemon=True).start()
    settings.KODERA_MEDIA_ROOM_VERIFIER_URL = media_room_verifier_url(
        {
            "KODERA_MEDIA_ROOM_VERIFIER_URL": (
                f"http://127.0.0.1:{verifier_srv.server_address[1]}/internal/room-member"
            )
        }
    )

    try:
        root = f"/api/v1/organisations/{org.id}/workspace/attachments"
        created = client.post(
            root + "/uploads",
            data=json.dumps(
                {
                    "filename": "dm-lock-check.txt",
                    "contentType": "text/plain",
                    "sizeBytes": 24,
                    "sha256": hashlib.sha256(b"dm-lock-check-24-bytes!!").hexdigest(),
                    "roomId": dm_room,
                }
            ),
            content_type="application/json",
            **headers(credentials[3]),
        )
        assert created.status_code == 201
        dm_id = created.json()["attachmentId"]

        complete_auth = headers(credentials[3])
        intercept.set()

        def run_post_and_probe_locks(expected_min_calls: int) -> int:
            result_box: dict[str, Any] = {}

            def worker() -> None:
                try:
                    worker_client = Client()
                    result_box["resp"] = worker_client.post(
                        f"{root}/{dm_id}/complete",
                        data=b"",
                        content_type="application/json",
                        **complete_auth,
                    )
                except BaseException as exc:  # noqa: BLE001
                    result_box["err"] = exc
                finally:
                    connections.close_all()

            t = threading.Thread(target=worker)
            t.start()
            observed = 0
            while t.is_alive() or not pauses.empty():
                try:
                    resume = pauses.get(timeout=0.05)
                except queue.Empty:
                    continue
                observed += 1
                try:
                    with transaction.atomic():
                        locked_ws = Workspace.objects.select_for_update(nowait=True).get(
                            id=workspace.id
                        )
                        locked_att = Attachment.objects.select_for_update(nowait=True).get(id=dm_id)
                        assert locked_ws.id == workspace.id and str(locked_att.id) == dm_id
                finally:
                    resume.set()
            t.join(timeout=5.0)
            assert "err" not in result_box, result_box.get("err")
            resp = result_box["resp"]
            assert resp.status_code == 200 and "downloadUrl" in resp.json()
            assert observed >= expected_min_calls
            return observed

        # Fresh HTTP completion pauses on pre-commit AND post-commit verifier HTTP I/O with zero DB locks
        run_post_and_probe_locks(expected_min_calls=3)
        # Cached idempotency replay ALSO pauses on post-commit verifier HTTP I/O with zero DB locks
        run_post_and_probe_locks(expected_min_calls=1)
    finally:
        intercept.clear()
        while not pauses.empty():
            pauses.get_nowait().set()
        verifier_srv.shutdown()
        verifier_srv.server_close()
