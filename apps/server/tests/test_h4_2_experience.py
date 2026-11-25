"""Comprehensive H4.2 tests: pure-Python RIFF/WebP sanitizer, confidential 403 refusals,
Send Later & Personal Reminder dispatchers (lock-free Matrix send, mid-flight revocation &
GDPR Art. 17 erasure cutoffs + compensating redact), Kodera Labs preferences, and API writer ACL.
"""

from __future__ import annotations

import base64
import json
import struct
from dataclasses import replace
from datetime import timedelta
from typing import Any
from uuid import uuid4

import pytest
from customer_http_fixtures import http_signer as http_signer
from django.core.management import call_command
from django.db import connection, transaction
from django.test import override_settings
from django.utils import timezone
from test_access_tokens import frozen_clock as frozen_clock
from test_intake_writer_role import INSUFFICIENT_PRIVILEGE, acting_as, refused
from workspace_safety.test_moderation import world as world
from workspace_safety.test_moderation_http import http as http

from apps.e2ee.models import Room as ConfidentialRoom
from apps.identity import services as identity_services
from apps.notifications import reminder_dispatcher, services as notification_services
from apps.notifications.models import Notification, PersonalReminder
from apps.orgs.account_erasure_services import begin_account_erasure, purge_account_core
from apps.orgs.erasure_services import advance_erasure, begin_erasure, database_now
from apps.orgs.privacy_models import PrivacyErasure
from apps.workspaces import scheduled_dispatcher, services as workspace_services
from apps.workspaces.custom_emojis import (
    CustomEmojiValidationError,
    sanitize_custom_emoji_webp,
    validate_shortcode,
    verify_custom_emoji_webp_clean,
)
from apps.workspaces.models import (
    Channel,
    MemberWorkspacePreference,
    ResourcePolicy,
    ResourcePolicyRule,
    ScheduledMessage,
    Workspace,
    WorkspaceCustomEmoji,
    WorkspaceMemberRestriction,
)
from core.db import api_writer_role
from dev.api_writer_role import grant_statements

pytestmark = pytest.mark.django_db(transaction=True)


def _riff_chunk(fourcc: bytes, payload: bytes) -> bytes:
    pad = b"\x00" if (len(payload) & 1) else b""
    return fourcc + struct.pack("<I", len(payload)) + payload + pad


def _build_riff_webp(chunks: list[tuple[bytes, bytes]]) -> bytes:
    body = b"WEBP" + b"".join(_riff_chunk(tag, data) for tag, data in chunks)
    return b"RIFF" + struct.pack("<I", len(body)) + body


def _vp8_lossy_payload(width: int = 64, height: int = 64) -> bytes:
    # Uncompressed 3-byte frame tag (keyframe bit 0 == 0) + 0x9d 0x01 0x2a + 16-bit dims + 4 bytes
    frame_tag = b"\x10\x00\x00"
    start_code = b"\x9d\x01\x2a"
    dims = struct.pack("<HH", width & 0x3FFF, height & 0x3FFF)
    return frame_tag + start_code + dims + b"\x01\x02\x03"  # odd length (13 bytes) to test padding!


def _vp8l_lossless_payload(width: int = 48, height: int = 32) -> bytes:
    bits = ((width - 1) & 0x3FFF) | (((height - 1) & 0x3FFF) << 14)
    return b"\x2f" + struct.pack("<I", bits) + b"\xaa\xbb"


def _vp8x_header(flags: int, width: int = 64, height: int = 64) -> bytes:
    w_m1 = (width - 1).to_bytes(3, "little")
    h_m1 = (height - 1).to_bytes(3, "little")
    return bytes([flags, 0, 0, 0]) + w_m1 + h_m1


def _auth_headers(token: str, *, key: str | None = None) -> dict[str, str]:
    headers = {"HTTP_AUTHORIZATION": f"Bearer {token}"}
    if key is not None:
        headers["HTTP_IDEMPOTENCY_KEY"] = key
    return headers


def _create_channel(
    workspace: Workspace,
    *,
    name: str = "General",
    is_confidential: bool = False,
) -> Channel:
    policy = ResourcePolicy.objects.create(workspace=workspace, visibility="organisation")
    if workspace.default_policy_id is None:
        Workspace.objects.filter(pk=workspace.id).update(default_policy=policy)
    next_pos = Channel.objects.filter(workspace=workspace, category__isnull=True).count() + 1
    return Channel.objects.create(
        workspace=workspace,
        name=name,
        kind="text",
        lifecycle="active",
        room_state="ready",
        position=next_pos,
        policy_mode="explicit",
        explicit_policy=policy,
        is_confidential=is_confidential,
    )


class FakeMatrixReplayTransport:
    def __init__(
        self,
        *,
        on_send: Any = None,
        room_overrides: dict[str, str] | None = None,
    ) -> None:
        self.sent: list[dict[str, Any]] = []
        self.redacted: list[dict[str, Any]] = []
        self.in_atomic_during_send: list[bool] = []
        self.in_atomic_during_resolve: list[bool] = []
        self._on_send = on_send
        self._room_overrides = dict(room_overrides or {})

    def resolve_channel_room(self, channel_id: Any) -> str:
        self.in_atomic_during_resolve.append(connection.in_atomic_block)
        override = self._room_overrides.get(str(channel_id))
        if override is not None:
            return override
        return f"!room-{channel_id}:acme.kodera.io"

    def send_message(self, *, room_id: str, txn_id: str, content: dict[str, Any]) -> str:
        self.in_atomic_during_send.append(connection.in_atomic_block)
        event_id = f"$evt-{len(self.sent) + 1}"
        self.sent.append(
            {
                "room_id": room_id,
                "txn_id": txn_id,
                "content": content,
                "event_id": event_id,
            }
        )
        if self._on_send is not None:
            self._on_send(room_id, txn_id, event_id)
        return event_id

    def redact_message(
        self, *, room_id: str, event_id: str, txn_id: str, reason: str = "authority_revoked"
    ) -> str:
        redact_id = f"$redact-{len(self.redacted) + 1}"
        self.redacted.append(
            {
                "room_id": room_id,
                "event_id": event_id,
                "txn_id": txn_id,
                "reason": reason,
            }
        )
        return redact_id


# ------------------------------------------------ 1. Pure-Python RIFF/WebP Sanitizer ---


def test_pure_python_webp_sanitizer_strips_exif_xmp_iccp_clears_vp8x_bits_and_pads() -> None:
    # Extended VP8X with ICCP (0x20), Alpha (0x10), EXIF (0x08), XMP (0x04), Animation (0x02).
    dirty_flags = 0x20 | 0x10 | 0x08 | 0x04 | 0x02
    anmf_frame = (
        (0).to_bytes(3, "little")
        + (0).to_bytes(3, "little")
        + (63).to_bytes(3, "little")
        + (63).to_bytes(3, "little")
        + (80).to_bytes(3, "little")
        + b"\x00"
        + _riff_chunk(b"VP8 ", _vp8_lossy_payload(64, 64))
    )
    dirty_webp = _build_riff_webp(
        [
            (b"VP8X", _vp8x_header(dirty_flags, 64, 64)),
            (b"ICCP", b"fake-icc-color-profile-payload"),
            (b"ANIM", b"\x00\x00\x00\x00\x00\x00"),
            (b"ANMF", anmf_frame),
            (b"EXIF", b"Exif\x00\x00GPS-coordinates-secret"),
            (b"XMP ", b"<?xpacket begin=''?><x:xmpmeta>author</x:xmpmeta>"),
        ]
    )

    result = sanitize_custom_emoji_webp(dirty_webp)
    assert result.width == 64
    assert result.height == 64
    assert result.animated is True
    assert len(result.sha256) == 64
    assert b"Exif" not in result.webp_bytes
    assert b"xmpmeta" not in result.webp_bytes
    assert b"fake-icc" not in result.webp_bytes
    assert b"EXIF" not in result.webp_bytes
    assert b"XMP " not in result.webp_bytes
    assert b"ICCP" not in result.webp_bytes

    # Verify RIFF header size matches exact payload length and VP8X metadata bits were cleared!
    riff_size = struct.unpack_from("<I", result.webp_bytes, 4)[0]
    assert riff_size == len(result.webp_bytes) - 8
    # VP8X flags at byte offset 20: only Alpha (0x10) | Animation (0x02) remain!
    assert result.webp_bytes[12:16] == b"VP8X"
    assert result.webp_bytes[20] == (0x10 | 0x02)
    verify_custom_emoji_webp_clean(result.webp_bytes)


def test_webp_sanitizer_rejects_oversized_dimensions_polyglots_and_reserved_shortcodes() -> None:
    # > 128px rejected across VP8, VP8L, and VP8X.
    too_wide_vp8 = _build_riff_webp([(b"VP8 ", _vp8_lossy_payload(129, 64))])
    with pytest.raises(CustomEmojiValidationError) as exc_info:
        sanitize_custom_emoji_webp(too_wide_vp8)
    assert exc_info.value.code == "invalid_dimensions"

    too_tall_vp8l = _build_riff_webp([(b"VP8L", _vp8l_lossless_payload(64, 140))])
    with pytest.raises(CustomEmojiValidationError) as exc_info2:
        sanitize_custom_emoji_webp(too_tall_vp8l)
    assert exc_info2.value.code == "invalid_dimensions"

    # SVG / HTML / script polyglot inside bitstream is refused!
    svg_polyglot = _build_riff_webp(
        [(b"VP8 ", _vp8_lossy_payload(32, 32) + b"<svg onload=alert(1)>")]
    )
    with pytest.raises(CustomEmojiValidationError) as exc_poly:
        sanitize_custom_emoji_webp(svg_polyglot)
    assert exc_poly.value.code == "polyglot_or_markup_refused"

    # Raw SVG bytes refused immediately.
    with pytest.raises(CustomEmojiValidationError):
        sanitize_custom_emoji_webp(b"<svg xmlns='http://www.w3.org/2000/svg'></svg>")

    # Oversized > 256 KiB refused.
    with pytest.raises(CustomEmojiValidationError) as exc_size:
        sanitize_custom_emoji_webp(b"RIFF" + b"\x00" * 270_000)
    assert exc_size.value.code == "size_out_of_bounds"

    # Reserved `kodera_*` shortcode refused!
    with pytest.raises(CustomEmojiValidationError) as exc_code:
        validate_shortcode("kodera_custom")
    assert exc_code.value.code == "reserved_shortcode_prefix"
    assert validate_shortcode("party_parrot") == "party_parrot"


# --------------------------------- 2. HTTP Endpoints, Confidential 403 & Writer ACL ---


@override_settings(
    ROOT_URLCONF="config.customer_urls",
    KODERA_MATRIX_REPLAY_TRANSPORT_FACTORY=FakeMatrixReplayTransport,
)
def test_http_endpoints_confidential_403_webp_headers_and_api_writer_acl(
    world: Any,
    http: Any,
) -> None:
    org, workspace, _, _ = world
    client, credentials = http
    owner_cred = credentials[0]
    member_cred = credentials[3]

    open_ch = _create_channel(workspace, name="Open Chat", is_confidential=False)
    conf_ch = _create_channel(workspace, name="Vault Chat", is_confidential=True)
    e2ee_backed_ch = _create_channel(workspace, name="MLS Backed", is_confidential=False)
    ConfidentialRoom.objects.create(
        organisation=org,
        channel=e2ee_backed_ch,
        algorithm="io.kodera.mls.v1",
    )

    role = f"exp_api_writer_{uuid4().hex[:12]}"
    with connection.cursor() as cursor:
        cursor.execute(f'CREATE ROLE "{role}" NOLOGIN NOINHERIT')
        for statement in grant_statements(role):
            cursor.execute(statement)

    dirty_lossless = _build_riff_webp(
        [
            (b"VP8X", _vp8x_header(0x08, 48, 32)),
            (b"VP8L", _vp8l_lossless_payload(48, 32)),
            (b"EXIF", b"Exif\x00\x00CameraSerial12345"),
        ]
    )
    b64_webp = base64.b64encode(dirty_lossless).decode("ascii")

    try:
        with acting_as(role):
            # 1) Member cannot create custom emoji (403); owner creates and strips EXIF (201).
            mem_emoji_resp = client.post(
                f"/api/v1/organisations/{org.id}/workspace/emojis",
                data=json.dumps({"shortcode": "ship_it", "webpBase64": b64_webp}),
                content_type="application/json",
                **_auth_headers(member_cred, key=str(uuid4())),
            )
            assert mem_emoji_resp.status_code == 403

            reserved_resp = client.post(
                f"/api/v1/organisations/{org.id}/workspace/emojis",
                data=json.dumps({"shortcode": "kodera_fake", "webpBase64": b64_webp}),
                content_type="application/json",
                **_auth_headers(owner_cred, key=str(uuid4())),
            )
            assert reserved_resp.status_code == 422

            create_emoji_resp = client.post(
                f"/api/v1/organisations/{org.id}/workspace/emojis",
                data=json.dumps({"shortcode": "ship_it", "webpBase64": b64_webp}),
                content_type="application/json",
                **_auth_headers(owner_cred, key=str(uuid4())),
            )
            assert create_emoji_resp.status_code == 201
            emoji_id = create_emoji_resp.json()["id"]

            # Authenticated member reads list & sanitized WebP blob with strict security headers.
            list_resp = client.get(
                f"/api/v1/organisations/{org.id}/workspace/emojis",
                **_auth_headers(member_cred),
            )
            assert list_resp.status_code == 200
            assert [item["shortcode"] for item in list_resp.json()["items"]] == ["ship_it"]

            blob_resp = client.get(
                f"/api/v1/organisations/{org.id}/workspace/emojis/{emoji_id}/blob",
                **_auth_headers(member_cred),
            )
            assert blob_resp.status_code == 200
            assert blob_resp["Content-Type"] == "image/webp"
            assert blob_resp["X-Content-Type-Options"] == "nosniff"
            assert blob_resp["Content-Security-Policy"] == "default-src 'none'"
            assert b"CameraSerial12345" not in blob_resp.content
            verify_custom_emoji_webp_clean(blob_resp.content)

            # 2) Confidential / E2EE channels refuse Send Later and Reminders with 403 confidential_channel_refused!
            future_iso = (timezone.now() + timedelta(hours=2)).isoformat()
            for target_ch in (conf_ch, e2ee_backed_ch):
                sched_conf = client.post(
                    f"/api/v1/organisations/{org.id}/workspace/scheduled-messages",
                    data=json.dumps(
                        {
                            "channelId": str(target_ch.id),
                            "roomId": f"!room-{target_ch.id}:acme.kodera.io",
                            "body": "Secret deferred text",
                            "deliverAt": future_iso,
                        }
                    ),
                    content_type="application/json",
                    **_auth_headers(member_cred, key=str(uuid4())),
                )
                assert sched_conf.status_code == 403
                assert sched_conf.json()["code"] == "confidential_channel_refused"

                rem_conf = client.post(
                    f"/api/v1/organisations/{org.id}/workspace/reminders",
                    data=json.dumps(
                        {
                            "channelId": str(target_ch.id),
                            "roomId": f"!room-{target_ch.id}:acme.kodera.io",
                            "targetEventId": "$evt-secret",
                            "note": "Check confidential room",
                            "remindAt": future_iso,
                        }
                    ),
                    content_type="application/json",
                    **_auth_headers(member_cred, key=str(uuid4())),
                )
                assert rem_conf.status_code == 403
                assert rem_conf.json()["code"] == "confidential_channel_refused"

            # 3) Ordinary plaintext channel allows Send Later & Reminders CRUD + Kodera Labs preferences.
            sched_ok = client.post(
                f"/api/v1/organisations/{org.id}/workspace/scheduled-messages",
                data=json.dumps(
                    {
                        "channelId": str(open_ch.id),
                        "roomId": f"!room-{open_ch.id}:acme.kodera.io",
                        "body": "Bonjour l'équipe !",
                        "deliverAt": future_iso,
                    }
                ),
                content_type="application/json",
                **_auth_headers(member_cred, key=str(uuid4())),
            )
            assert sched_ok.status_code == 201
            sched_id = sched_ok.json()["id"]
            assert sched_ok.json()["matrixTxnId"].startswith("kodera-sched-")

            assert (
                client.patch(
                    f"/api/v1/organisations/{org.id}/workspace/scheduled-messages/{sched_id}",
                    data=json.dumps({"body": "Missing If-Match"}),
                    content_type="application/json",
                    **_auth_headers(member_cred),
                ).status_code
                == 428
            )

            sched_patch = client.patch(
                f"/api/v1/organisations/{org.id}/workspace/scheduled-messages/{sched_id}",
                data=json.dumps({"body": "Bonjour mis à jour !"}),
                content_type="application/json",
                HTTP_IF_MATCH="*",
                **_auth_headers(member_cred),
            )
            assert sched_patch.status_code == 200
            assert sched_patch.json()["body"] == "Bonjour mis à jour !"

            sched_del = client.delete(
                f"/api/v1/organisations/{org.id}/workspace/scheduled-messages/{sched_id}",
                **_auth_headers(member_cred),
            )
            assert sched_del.status_code == 204

            rem_ok = client.post(
                f"/api/v1/organisations/{org.id}/workspace/reminders",
                data=json.dumps(
                    {
                        "channelId": str(open_ch.id),
                        "roomId": f"!room-{open_ch.id}:acme.kodera.io",
                        "targetEventId": "$evt-open-1",
                        "note": "Relire le compte-rendu",
                        "remindAt": future_iso,
                    }
                ),
                content_type="application/json",
                **_auth_headers(member_cred, key=str(uuid4())),
            )
            assert rem_ok.status_code == 201
            rem_id = rem_ok.json()["id"]

            rem_patch = client.patch(
                f"/api/v1/organisations/{org.id}/workspace/reminders/{rem_id}",
                data=json.dumps({"state": "completed"}),
                content_type="application/json",
                HTTP_IF_MATCH="*",
                **_auth_headers(member_cred),
            )
            assert rem_patch.status_code == 200
            assert rem_patch.json()["state"] == "completed"

            pref_patch = client.patch(
                f"/api/v1/organisations/{org.id}/workspace/preferences/me",
                data=json.dumps(
                    {
                        "labsFlags": {"send_later": False, "waiting_room_ambience": True},
                        "waitingRoomAmbience": True,
                    }
                ),
                content_type="application/json",
                HTTP_IF_MATCH="*",
                **_auth_headers(member_cred),
            )
            assert pref_patch.status_code == 200
            assert pref_patch.json()["labsFlags"]["send_later"] is False
            assert pref_patch.json()["waitingRoomAmbience"] is True

            # Owner revokes custom emoji -> 204, blob becomes 404.
            del_emoji = client.delete(
                f"/api/v1/organisations/{org.id}/workspace/emojis/{emoji_id}",
                **_auth_headers(owner_cred),
            )
            assert del_emoji.status_code == 204
            assert (
                client.get(
                    f"/api/v1/organisations/{org.id}/workspace/emojis/{emoji_id}/blob",
                    **_auth_headers(member_cred),
                ).status_code
                == 404
            )

            # 4) Least-privilege API writer role cannot DELETE rows or mutate worker lease columns!
            assert refused("DELETE FROM workspaces_scheduledmessage") == INSUFFICIENT_PRIVILEGE
            assert refused("DELETE FROM notifications_personalreminder") == INSUFFICIENT_PRIVILEGE
            assert (
                refused("UPDATE workspaces_scheduledmessage SET lease_id = gen_random_uuid()")
                == INSUFFICIENT_PRIVILEGE
            )
            assert (
                refused("UPDATE notifications_personalreminder SET lease_id = gen_random_uuid()")
                == INSUFFICIENT_PRIVILEGE
            )
    finally:
        with connection.cursor() as cursor:
            cursor.execute(f'DROP OWNED BY "{role}"')
            cursor.execute(f'DROP ROLE "{role}"')

    for table in (
        "workspaces_workspacecustomemoji",
        "workspaces_scheduledmessage",
        "workspaces_memberworkspacepreference",
        "notifications_personalreminder",
    ):
        assert table in api_writer_role.SELECT
        assert table in api_writer_role.INSERT
        assert table not in api_writer_role.DELETE


# ---------------- 3. Dispatchers, Mid-Flight Revocation, Erasure & Compensating Redact ---


@override_settings(KODERA_MATRIX_REPLAY_TRANSPORT_FACTORY=FakeMatrixReplayTransport)
def test_operator_dispatchers_enforce_profile_release_locks_and_compensating_redact(
    world: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    org, workspace, members, tokens = world
    author = members[3]  # ordinary member
    open_ch = _create_channel(workspace, name="Announcements", is_confidential=False)

    # Non-operator profile is refused by both management commands.
    from django.apps import apps as django_apps
    from django.core.management.base import CommandError

    real_is_installed = django_apps.is_installed
    with monkeypatch.context() as mp:
        mp.setattr(
            django_apps, "is_installed", lambda app: app != "apps.jobs" and real_is_installed(app)
        )
        with pytest.raises(CommandError, match="not all installed"):
            call_command("dispatch_scheduled_messages", "--once")
        with pytest.raises(CommandError, match="not all installed"):
            call_command("dispatch_reminders", "--once")

    due_past = timezone.now() - timedelta(seconds=30)

    # Case A: Normal delivery releases DB locks before Matrix send and commits `delivered`.
    msg_ok = ScheduledMessage.objects.create(
        organisation=org,
        workspace=workspace,
        channel=open_ch,
        room_id=f"!room-{open_ch.id}:acme.kodera.io",
        author=author,
        body="Scheduled release note",
        deliver_at=due_past,
        matrix_txn_id=f"kodera-sched-{uuid4().hex}",
    )
    transport_ok = FakeMatrixReplayTransport()
    summary_ok = scheduled_dispatcher.dispatch_scheduled_messages(
        matrix_client=transport_ok, organisation_id=org.id, max_jobs=25
    )
    assert summary_ok["delivered"] == 1
    assert summary_ok["redacted_compensating"] == 0
    assert transport_ok.in_atomic_during_send == [False]
    msg_ok.refresh_from_db()
    assert msg_ok.state == "delivered"
    assert msg_ok.matrix_event_id == "$evt-1"

    # Case B: Mid-flight member ban while Matrix send is in flight -> compensating redact + `refused_policy`!
    msg_banned = ScheduledMessage.objects.create(
        organisation=org,
        workspace=workspace,
        channel=open_ch,
        room_id=f"!room-{open_ch.id}:acme.kodera.io",
        author=author,
        body="Should be redacted on mid-flight ban",
        deliver_at=due_past,
        matrix_txn_id=f"kodera-sched-{uuid4().hex}",
    )

    def _ban_mid_flight(_room: str, _txn: str, _evt: str) -> None:
        WorkspaceMemberRestriction.objects.create(
            workspace=workspace, membership=author, banned=True
        )

    transport_ban = FakeMatrixReplayTransport(on_send=_ban_mid_flight)
    summary_ban = scheduled_dispatcher.dispatch_scheduled_messages(
        matrix_client=transport_ban, organisation_id=org.id, max_jobs=25
    )
    assert summary_ban["refused_policy"] == 1
    assert summary_ban["redacted_compensating"] == 1
    assert len(transport_ban.redacted) == 1
    assert transport_ban.redacted[0]["event_id"] == "$evt-1"
    msg_banned.refresh_from_db()
    assert msg_banned.state == "refused_policy"
    assert msg_banned.failure_reason == "member_banned_or_kicked"

    # Clear restriction for next cases.
    WorkspaceMemberRestriction.objects.filter(workspace=workspace, membership=author).delete()

    # Case C: Mid-flight channel policy denial (`message.post` denied) -> compensating redact + `refused_policy`!
    msg_denied = ScheduledMessage.objects.create(
        organisation=org,
        workspace=workspace,
        channel=open_ch,
        room_id=f"!room-{open_ch.id}:acme.kodera.io",
        author=author,
        body="Should be redacted on mid-flight read-only policy",
        deliver_at=due_past,
        matrix_txn_id=f"kodera-sched-{uuid4().hex}",
    )

    def _deny_post_mid_flight(_room: str, _txn: str, _evt: str) -> None:
        assert open_ch.explicit_policy_id is not None
        ResourcePolicyRule.objects.create(
            policy_id=open_ch.explicit_policy_id,
            kind=ResourcePolicyRule.Kind.DENY_CAPABILITY,
            capability="message.post",
        )

    transport_deny = FakeMatrixReplayTransport(on_send=_deny_post_mid_flight)
    summary_deny = scheduled_dispatcher.dispatch_scheduled_messages(
        matrix_client=transport_deny, organisation_id=org.id, max_jobs=25
    )
    assert summary_deny["refused_policy"] == 1
    assert summary_deny["redacted_compensating"] == 1
    msg_denied.refresh_from_db()
    assert msg_denied.state == "refused_policy"
    assert msg_denied.failure_reason == "channel_post_denied"

    ResourcePolicyRule.objects.filter(
        policy_id=open_ch.explicit_policy_id, capability="message.post"
    ).delete()

    # Case D: Personal Reminder normal firing + inbox visibility, then mid-flight ban refusal!
    rem_ok = PersonalReminder.objects.create(
        organisation=org,
        membership=author,
        channel=open_ch,
        room_id=f"!room-{open_ch.id}:acme.kodera.io",
        target_event_id="$evt-remind-1",
        note="Follow up on PR",
        remind_at=due_past,
    )
    rem_summary = reminder_dispatcher.dispatch_reminders(organisation_id=org.id, max_jobs=25)
    assert rem_summary == {"fired": 1, "obsoleted": 0}
    rem_ok.refresh_from_db()
    assert rem_ok.state == "fired"
    assert rem_ok.notification_id is not None
    assert Notification.objects.filter(id=rem_ok.notification_id, kind="reminder").exists()

    inbox_page = notification_services.inbox(verified=tokens[3], cursor=None, limit=20)
    assert any(
        item["kind"] == "reminder" and item["resourceId"] == str(rem_ok.id)
        for item in inbox_page["data"]
    )

    rem_revoked = PersonalReminder.objects.create(
        organisation=org,
        membership=author,
        channel=open_ch,
        room_id=f"!room-{open_ch.id}:acme.kodera.io",
        target_event_id="$evt-remind-2",
        note="Revoked mid-flight",
        remind_at=due_past,
    )

    def _ban_before_reminder_fire(_job: Any) -> None:
        WorkspaceMemberRestriction.objects.create(
            workspace=workspace, membership=author, kicked=True
        )

    rem_rev_summary = reminder_dispatcher.dispatch_reminders(
        organisation_id=org.id, max_jobs=25, mid_flight_hook=_ban_before_reminder_fire
    )
    assert rem_rev_summary == {"fired": 0, "obsoleted": 1}
    rem_revoked.refresh_from_db()
    assert rem_revoked.state == "obsolete"
    assert rem_revoked.notification_id is None
    WorkspaceMemberRestriction.objects.filter(workspace=workspace, membership=author).delete()


@override_settings(KODERA_MATRIX_REPLAY_TRANSPORT_FACTORY=FakeMatrixReplayTransport)
def test_mid_flight_gdpr_erasure_refusal_restore_rehearsal_disarm_and_core_purge(
    world: Any,
) -> None:
    org, workspace, members, tokens = world
    owner = members[0]
    member = members[3]
    open_ch = _create_channel(workspace, name="General", is_confidential=False)

    clean_webp = sanitize_custom_emoji_webp(
        _build_riff_webp([(b"VP8L", _vp8l_lossless_payload(32, 32))])
    )
    WorkspaceCustomEmoji.objects.create(
        organisation=org,
        workspace=workspace,
        creator=owner,
        shortcode="team_wave",
        webp_bytes=clean_webp.webp_bytes,
        sha256=clean_webp.sha256,
        width=clean_webp.width,
        height=clean_webp.height,
        animated=False,
    )
    MemberWorkspacePreference.objects.create(
        organisation=org,
        workspace=workspace,
        membership=member,
        labs_flags={"send_later": True},
        waiting_room_ambience=True,
    )

    # Restore rehearsal disarms pending rows inside atomic block.
    sched_rehearsal = ScheduledMessage.objects.create(
        organisation=org,
        workspace=workspace,
        channel=open_ch,
        room_id="!room-reh:acme.kodera.io",
        author=owner,
        body="Rehearsal disarm check",
        deliver_at=timezone.now() + timedelta(hours=1),
        matrix_txn_id=f"kodera-sched-{uuid4().hex}",
    )
    rem_rehearsal = PersonalReminder.objects.create(
        organisation=org,
        membership=owner,
        channel=open_ch,
        room_id="!room-reh:acme.kodera.io",
        target_event_id="$evt-reh",
        note="Rehearsal reminder",
        remind_at=timezone.now() + timedelta(hours=1),
    )
    with transaction.atomic():
        now = timezone.now()
        ws_disarm = workspace_services.disarm_rehearsal_outbound(now=now)
        notif_disarm = notification_services.disarm_rehearsal_outbound(now=now)
    assert ws_disarm["scheduled_messages_disarmed"] == 1
    assert notif_disarm["personal_reminders_disarmed"] == 1
    sched_rehearsal.refresh_from_db()
    rem_rehearsal.refresh_from_db()
    assert sched_rehearsal.state == "obsolete"
    assert rem_rehearsal.state == "obsolete"

    # Mid-flight AccountErasure on `member` while ScheduledMessage is in-flight -> compensating redact + `obsolete`!
    due_past = timezone.now() - timedelta(seconds=20)
    sched_erased = ScheduledMessage.objects.create(
        organisation=org,
        workspace=workspace,
        channel=open_ch,
        room_id=f"!room-{open_ch.id}:acme.kodera.io",
        author=member,
        body="Erased mid-flight",
        deliver_at=due_past,
        matrix_txn_id=f"kodera-sched-{uuid4().hex}",
    )
    rem_erased = PersonalReminder.objects.create(
        organisation=org,
        membership=member,
        channel=open_ch,
        room_id=f"!room-{open_ch.id}:acme.kodera.io",
        target_event_id="$evt-erase",
        note="Erased reminder",
        remind_at=due_past,
    )
    operator_id = identity_services.ensure_rehearsal_operator_identity()
    erasure_holder: list[Any] = []

    def _admit_account_erasure_mid_flight(_room: str, _txn: str, _evt: str) -> None:
        fresh_tok = replace(tokens[3], auth_time=int(database_now().timestamp()))
        acct = begin_account_erasure(
            verified=fresh_tok,
            confirmation="delete",
            instruction_ref="ERA-101",
            instruction_sha256="a" * 64,
            purge_not_before=database_now(),
            actor_identity_id=operator_id,
        )
        erasure_holder.append(acct)

    transport_erase = FakeMatrixReplayTransport(on_send=_admit_account_erasure_mid_flight)
    sched_summary = scheduled_dispatcher.dispatch_scheduled_messages(
        matrix_client=transport_erase, organisation_id=org.id, max_jobs=25
    )
    assert sched_summary["obsoleted"] == 1
    assert sched_summary["redacted_compensating"] == 1
    sched_erased.refresh_from_db()
    assert sched_erased.state == "obsolete"
    assert sched_erased.failure_reason == "account_erasure_cutoff"

    # Reminder dispatcher also refuses delivery under AccountErasure cutoff!
    rem_summary = reminder_dispatcher.dispatch_reminders(organisation_id=org.id, max_jobs=25)
    assert rem_summary["obsoleted"] == 1
    rem_erased.refresh_from_db()
    assert rem_erased.state == "obsolete"

    # Purging account Core deletes member's ScheduledMessage, MemberWorkspacePreference, and PersonalReminder!
    purge_account_core(erasure_holder[0].id)
    assert workspace_services.count_residual_experience_rows_for_user(user_id=member.user_id) == 0
    assert notification_services.count_residual_rows_for_user(user_id=member.user_id) == 0

    # Full organisation Art. 17 erasure purges remaining custom emojis, scheduled messages, preferences & reminders!
    org_erasure = begin_erasure(
        organisation_id=org.id,
        instruction_ref="ORG-202",
        instruction_sha256="b" * 64,
        purge_not_before=database_now(),
        actor_identity_id=operator_id,
    )
    assert PrivacyErasure.objects.filter(pk=org_erasure.id).exists()
    progress = advance_erasure(org_erasure.id, {})
    assert progress["core_purged"] is True
    assert (
        workspace_services.count_residual_experience_rows_for_organisation(organisation_id=org.id)
        == 0
    )
    assert notification_services.count_residual_rows_for_organisation(organisation_id=org.id) == 0


@override_settings(
    ROOT_URLCONF="config.customer_urls",
    KODERA_MATRIX_REPLAY_TRANSPORT_FACTORY=FakeMatrixReplayTransport,
)
def test_p1_1_and_p2_1_room_channel_binding_idempotency_and_etag_concurrency(
    world: Any,
    http: Any,
) -> None:
    org, workspace, members, _ = world
    client, credentials = http
    owner_cred = credentials[0]
    member_cred = credentials[3]
    author = members[3]

    open_ch = _create_channel(workspace, name="Primary Plaintext", is_confidential=False)
    other_ch = _create_channel(workspace, name="Other Plaintext", is_confidential=False)
    future_iso = (timezone.now() + timedelta(hours=3)).isoformat()

    # --- P1-1: Unbound room-only requests & mismatched (channelId, roomId) are refused ---
    for path, extra in (
        (
            f"/api/v1/organisations/{org.id}/workspace/scheduled-messages",
            {"body": "Unbound room attempt", "deliverAt": future_iso},
        ),
        (
            f"/api/v1/organisations/{org.id}/workspace/reminders",
            {"targetEventId": "$evt-1", "note": "Unbound reminder", "remindAt": future_iso},
        ),
    ):
        unbound_resp = client.post(
            path,
            data=json.dumps({"roomId": "!unverified-secret:acme.kodera.io", **extra}),
            content_type="application/json",
            **_auth_headers(member_cred, key=str(uuid4())),
        )
        assert unbound_resp.status_code == 422
        assert unbound_resp.json()["code"] == "channel_binding_required"

        mismatch_resp = client.post(
            path,
            data=json.dumps(
                {
                    "channelId": str(open_ch.id),
                    "roomId": f"!room-{other_ch.id}:acme.kodera.io",
                    **extra,
                }
            ),
            content_type="application/json",
            **_auth_headers(member_cred, key=str(uuid4())),
        )
        assert mismatch_resp.status_code == 422
        assert mismatch_resp.json()["code"] == "channel_room_mismatch"

    # Dispatcher also refuses tampered DB rows whose room_id disagrees with channel binding!
    due_past = timezone.now() - timedelta(seconds=15)
    tampered_sched = ScheduledMessage.objects.create(
        organisation=org,
        workspace=workspace,
        channel=open_ch,
        room_id=f"!room-{other_ch.id}:acme.kodera.io",
        author=author,
        body="Tampered room target",
        deliver_at=due_past,
        matrix_txn_id=f"kodera-sched-{uuid4().hex}",
    )
    tampered_transport = FakeMatrixReplayTransport()
    tampered_summary = scheduled_dispatcher.dispatch_scheduled_messages(
        matrix_client=tampered_transport, organisation_id=org.id, max_jobs=10
    )
    assert tampered_summary["refused_policy"] == 1
    assert len(tampered_transport.sent) == 0
    tampered_sched.refresh_from_db()
    assert tampered_sched.state == "refused_policy"
    assert tampered_sched.failure_reason == "channel_room_mismatch"

    tampered_rem = PersonalReminder.objects.create(
        organisation=org,
        membership=author,
        channel=open_ch,
        room_id=f"!room-{other_ch.id}:acme.kodera.io",
        target_event_id="$evt-tampered",
        note="Tampered reminder",
        remind_at=due_past,
    )
    rem_summary = reminder_dispatcher.dispatch_reminders(organisation_id=org.id, max_jobs=10)
    assert rem_summary["obsoleted"] == 1
    tampered_rem.refresh_from_db()
    assert tampered_rem.state == "obsolete"

    # --- P2-1: Idempotency-Key replay/conflict on POST & ETag / If-Match 428/412 on PATCH ---
    clean_webp_b64 = base64.b64encode(
        _build_riff_webp([(b"VP8L", _vp8l_lossless_payload(32, 32))])
    ).decode("ascii")

    # Missing Idempotency-Key -> 400
    no_key = client.post(
        f"/api/v1/organisations/{org.id}/workspace/emojis",
        data=json.dumps({"shortcode": "idem_test", "webpBase64": clean_webp_b64}),
        content_type="application/json",
        **_auth_headers(owner_cred),
    )
    assert no_key.status_code == 400

    sched_key = f"sched-idem-{uuid4().hex}"
    sched_payload = {
        "channelId": str(open_ch.id),
        "body": "Idempotent Send Later",
        "deliverAt": future_iso,
    }
    s1 = client.post(
        f"/api/v1/organisations/{org.id}/workspace/scheduled-messages",
        data=json.dumps(sched_payload),
        content_type="application/json",
        **_auth_headers(member_cred, key=sched_key),
    )
    assert s1.status_code == 201
    assert "Idempotency-Replayed" not in s1
    s1_etag = s1["ETag"]
    assert s1_etag.startswith('"') and s1_etag.endswith('"')
    s1_id = s1.json()["id"]

    # Exact replay returns stored 201 + Idempotency-Replayed: true + same id
    s2 = client.post(
        f"/api/v1/organisations/{org.id}/workspace/scheduled-messages",
        data=json.dumps(sched_payload),
        content_type="application/json",
        **_auth_headers(member_cred, key=sched_key),
    )
    assert s2.status_code == 201
    assert s2["Idempotency-Replayed"] == "true"
    assert s2.json()["id"] == s1_id

    # Same Idempotency-Key with mutated body -> 409 conflict
    s_conflict = client.post(
        f"/api/v1/organisations/{org.id}/workspace/scheduled-messages",
        data=json.dumps({**sched_payload, "body": "Mutated payload"}),
        content_type="application/json",
        **_auth_headers(member_cred, key=sched_key),
    )
    assert s_conflict.status_code == 409

    # Stale If-Match on scheduled-message PATCH -> 412 precondition-failed with current_etag
    stale_patch = client.patch(
        f"/api/v1/organisations/{org.id}/workspace/scheduled-messages/{s1_id}",
        data=json.dumps({"body": "Stale attempt"}),
        content_type="application/json",
        HTTP_IF_MATCH='"0000000000000000000000000000000000000000000000000000000000000000"',
        **_auth_headers(member_cred),
    )
    assert stale_patch.status_code == 412
    assert stale_patch.json()["current_etag"] == s1_etag
    assert stale_patch["ETag"] == s1_etag

    # Matching If-Match -> 200 with rotated ETag
    fresh_patch = client.patch(
        f"/api/v1/organisations/{org.id}/workspace/scheduled-messages/{s1_id}",
        data=json.dumps({"body": "Updated with valid ETag"}),
        content_type="application/json",
        HTTP_IF_MATCH=s1_etag,
        **_auth_headers(member_cred),
    )
    assert fresh_patch.status_code == 200
    assert fresh_patch["ETag"] != s1_etag

    # Preferences GET returns ETag; missing If-Match -> 428; stale -> 412; valid -> 200
    pref_get = client.get(
        f"/api/v1/organisations/{org.id}/workspace/preferences/me",
        **_auth_headers(member_cred),
    )
    assert pref_get.status_code == 200
    pref_etag = pref_get["ETag"]
    assert (
        client.patch(
            f"/api/v1/organisations/{org.id}/workspace/preferences/me",
            data=json.dumps({"waitingRoomAmbience": True}),
            content_type="application/json",
            **_auth_headers(member_cred),
        ).status_code
        == 428
    )
    assert (
        client.patch(
            f"/api/v1/organisations/{org.id}/workspace/preferences/me",
            data=json.dumps({"waitingRoomAmbience": True}),
            content_type="application/json",
            HTTP_IF_MATCH='"stale-etag"',
            **_auth_headers(member_cred),
        ).status_code
        == 412
    )
    pref_ok = client.patch(
        f"/api/v1/organisations/{org.id}/workspace/preferences/me",
        data=json.dumps({"waitingRoomAmbience": True}),
        content_type="application/json",
        HTTP_IF_MATCH=pref_etag,
        **_auth_headers(member_cred),
    )
    assert pref_ok.status_code == 200
    assert pref_ok["ETag"] != pref_etag


@override_settings(ROOT_URLCONF="config.customer_urls")
def test_r2_opaque_synapse_room_resolution_outside_atomic_and_strict_strong_if_match(
    world: Any,
    http: Any,
    settings: Any,
) -> None:
    org, workspace, members, _ = world
    client, credentials = http
    member_cred = credentials[3]
    author = members[3]

    open_ch = _create_channel(workspace, name="Opaque Synapse Room", is_confidential=False)
    opaque_room_id = "!xK9pQ2opaqueSynapseRoom:acme.kodera.io"
    opaque_transport = FakeMatrixReplayTransport(room_overrides={str(open_ch.id): opaque_room_id})
    settings.KODERA_MATRIX_REPLAY_TRANSPORT_FACTORY = lambda: opaque_transport

    future_iso = (timezone.now() + timedelta(hours=2)).isoformat()

    # 1) Authoritative opaque Synapse room ID (`!opaque:domain`) is accepted on write paths AND
    # resolved strictly outside `transaction.atomic()` (`in_atomic_during_resolve == [False, ...]`)!
    sched_opaque = client.post(
        f"/api/v1/organisations/{org.id}/workspace/scheduled-messages",
        data=json.dumps(
            {
                "channelId": str(open_ch.id),
                "roomId": opaque_room_id,
                "body": "Opaque Synapse scheduled note",
                "deliverAt": future_iso,
            }
        ),
        content_type="application/json",
        **_auth_headers(member_cred, key=str(uuid4())),
    )
    assert sched_opaque.status_code == 201, sched_opaque.content
    assert sched_opaque.json()["roomId"] == opaque_room_id
    sched_id = sched_opaque.json()["id"]
    sched_etag = sched_opaque["ETag"]

    rem_opaque = client.post(
        f"/api/v1/organisations/{org.id}/workspace/reminders",
        data=json.dumps(
            {
                "channelId": str(open_ch.id),
                "roomId": opaque_room_id,
                "targetEventId": "$evt-opaque-1",
                "note": "Opaque Synapse reminder",
                "remindAt": future_iso,
            }
        ),
        content_type="application/json",
        **_auth_headers(member_cred, key=str(uuid4())),
    )
    assert rem_opaque.status_code == 201, rem_opaque.content
    assert rem_opaque.json()["roomId"] == opaque_room_id
    rem_id = rem_opaque.json()["id"]
    rem_etag = rem_opaque["ETag"]

    assert opaque_transport.in_atomic_during_resolve
    assert all(flag is False for flag in opaque_transport.in_atomic_during_resolve)

    # 2) Forged `!room-<channel.id>:<evil-domain>` strings NO LONGER bypass room verification!
    forged_room = f"!room-{open_ch.id}:evil.attacker.invalid"
    forged_sched = client.post(
        f"/api/v1/organisations/{org.id}/workspace/scheduled-messages",
        data=json.dumps(
            {
                "channelId": str(open_ch.id),
                "roomId": forged_room,
                "body": "Forged room attempt",
                "deliverAt": future_iso,
            }
        ),
        content_type="application/json",
        **_auth_headers(member_cred, key=str(uuid4())),
    )
    assert forged_sched.status_code == 422
    assert forged_sched.json()["code"] == "channel_room_mismatch"

    forged_rem = client.post(
        f"/api/v1/organisations/{org.id}/workspace/reminders",
        data=json.dumps(
            {
                "channelId": str(open_ch.id),
                "roomId": forged_room,
                "targetEventId": "$evt-forged-1",
                "note": "Forged room reminder",
                "remindAt": future_iso,
            }
        ),
        content_type="application/json",
        **_auth_headers(member_cred, key=str(uuid4())),
    )
    assert forged_rem.status_code == 422
    assert forged_rem.json()["code"] == "channel_room_mismatch"

    # 3) RFC 9110 §8.8.3 & §13.1.1 `If-Match`: weak validators (`W/"..."`) and non-matching `""`
    # fail with 412, malformed tokens fail with 400, AND comma-bearing quoted tags (`"previous,opaque"`)
    # plus empty strong tags (`""`) in multi-tag lists succeed with 200 OK (including `PATCH /reminders/{id}`
    # updating `remindAt` on an opaque Synapse room outside `transaction.atomic()`)!
    weak_sched = client.patch(
        f"/api/v1/organisations/{org.id}/workspace/scheduled-messages/{sched_id}",
        data=json.dumps({"body": "Weak validator must fail"}),
        content_type="application/json",
        HTTP_IF_MATCH=f"W/{sched_etag}",
        **_auth_headers(member_cred),
    )
    assert weak_sched.status_code == 412

    empty_only_sched = client.patch(
        f"/api/v1/organisations/{org.id}/workspace/scheduled-messages/{sched_id}",
        data=json.dumps({"body": "Empty strong tag alone must fail 412"}),
        content_type="application/json",
        HTTP_IF_MATCH='""',
        **_auth_headers(member_cred),
    )
    assert empty_only_sched.status_code == 412

    for bad_if_match in ('"unterminated', '*, "abc"', 'w/"lowercase"'):
        bad_resp = client.patch(
            f"/api/v1/organisations/{org.id}/workspace/scheduled-messages/{sched_id}",
            data=json.dumps({"body": "Malformed If-Match"}),
            content_type="application/json",
            HTTP_IF_MATCH=bad_if_match,
            **_auth_headers(member_cred),
        )
        assert bad_resp.status_code == 400

    comma_tag_sched = client.patch(
        f"/api/v1/organisations/{org.id}/workspace/scheduled-messages/{sched_id}",
        data=json.dumps({"body": "Opaque scheduled note updated via comma-list ETag"}),
        content_type="application/json",
        HTTP_IF_MATCH=f'"previous,opaque", {sched_etag}',
        **_auth_headers(member_cred),
    )
    assert comma_tag_sched.status_code == 200, comma_tag_sched.content

    weak_rem = client.patch(
        f"/api/v1/organisations/{org.id}/workspace/reminders/{rem_id}",
        data=json.dumps({"note": "Weak validator must fail"}),
        content_type="application/json",
        HTTP_IF_MATCH=f"W/{rem_etag}",
        **_auth_headers(member_cred),
    )
    assert weak_rem.status_code == 412

    opaque_transport.in_atomic_during_resolve.clear()
    updated_future_iso = (timezone.now() + timedelta(hours=3)).isoformat()
    patch_opaque_rem = client.patch(
        f"/api/v1/organisations/{org.id}/workspace/reminders/{rem_id}",
        data=json.dumps({"remindAt": updated_future_iso}),
        content_type="application/json",
        HTTP_IF_MATCH=f'"", "prior,tag", {rem_etag}',
        **_auth_headers(member_cred),
    )
    assert patch_opaque_rem.status_code == 200, patch_opaque_rem.content
    assert opaque_transport.in_atomic_during_resolve == [False]

    pref_get = client.get(
        f"/api/v1/organisations/{org.id}/workspace/preferences/me",
        **_auth_headers(member_cred),
    )
    assert pref_get.status_code == 200
    weak_pref = client.patch(
        f"/api/v1/organisations/{org.id}/workspace/preferences/me",
        data=json.dumps({"waitingRoomAmbience": True}),
        content_type="application/json",
        HTTP_IF_MATCH=f"W/{pref_get['ETag']}",
        **_auth_headers(member_cred),
    )
    assert weak_pref.status_code == 412

    # 4) Both dispatchers resolve opaque Synapse rooms outside DB transactions and reject forged `!room-<id>:*`!
    due_past = timezone.now() - timedelta(seconds=10)
    ScheduledMessage.objects.filter(id=sched_id).update(deliver_at=due_past)
    PersonalReminder.objects.filter(id=rem_id).update(remind_at=due_past)
    forged_row = PersonalReminder.objects.create(
        organisation=org,
        membership=author,
        channel=open_ch,
        room_id=forged_room,
        target_event_id="$evt-forged-disp",
        note="Tampered forged prefix",
        remind_at=due_past,
    )

    opaque_transport.in_atomic_during_resolve.clear()
    disp_sched = scheduled_dispatcher.dispatch_scheduled_messages(
        matrix_client=opaque_transport, organisation_id=org.id, max_jobs=10
    )
    assert disp_sched["delivered"] == 1
    assert opaque_transport.sent[-1]["room_id"] == opaque_room_id

    disp_rem = reminder_dispatcher.dispatch_reminders(
        organisation_id=org.id, max_jobs=10, matrix_client=opaque_transport
    )
    assert disp_rem == {"fired": 1, "obsoleted": 1}
    forged_row.refresh_from_db()
    assert forged_row.state == "obsolete"
    assert all(flag is False for flag in opaque_transport.in_atomic_during_resolve)
