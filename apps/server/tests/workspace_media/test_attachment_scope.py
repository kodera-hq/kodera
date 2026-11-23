"""Attachment capability creation and use share current workspace admission."""

from dataclasses import replace
from uuid import uuid4

import pytest
from django.db import transaction
from django.utils import timezone
from workspace_safety.test_moderation import world as world

from apps.identity.models import Identity, User
from apps.media import services
from apps.media.context import RefusalError
from apps.orgs.models import Membership, Organisation, SlugReservation
from apps.workspaces.models import Workspace, WorkspaceMemberRestriction
from workspace_media.test_media_services import gateway as gateway, upload

pytestmark = pytest.mark.django_db


def test_foreign_workspace_and_cross_workspace_attachment_ids_never_reach_signer(world, gateway):
    org, _, _, tokens = world
    ticket = upload(world, gateway)
    identifier = ticket["attachmentId"]
    services.complete_upload(
        verified=tokens[3],
        organisation_id=org.id,
        attachment_id=identifier,
        request_id=str(uuid4()),
    )
    with transaction.atomic():
        slug = "media-" + uuid4().hex[:12]
        other = Organisation.objects.create(
            slug=slug,
            realm=slug,
            issuer=f"https://identity.example.org/realms/{slug}",
            name="Other example",
            state="active",
        )
        SlugReservation.objects.create(
            organisation=other,
            slug=slug,
            namespace="organisation",
            state="permanent",
            protected_at=timezone.now(),
        )
        Workspace.objects.create(organisation=other)
        subject = str(uuid4())
        user = User.objects.create(email=f"{subject}@example.org")
        Identity.objects.create(
            user=user,
            organisation=other,
            issuer=other.issuer,
            realm=slug,
            subject=subject,
            email=user.email,
        )
        Membership.objects.create(
            organisation=other,
            user=user,
            role="org_owner",
            state="active",
            accepted_at=timezone.now(),
        )
    foreign_token = replace(tokens[3], issuer=other.issuer, subject=subject)
    before = len(gateway.calls)
    for token in (tokens[3], foreign_token):
        with pytest.raises(RefusalError) as denied:
            services.get_attachment(
                verified=token, organisation_id=other.id, attachment_id=identifier
            )
        assert denied.value.status in {403, 404}
        with pytest.raises(RefusalError) as denied:
            services.complete_upload(
                verified=token,
                organisation_id=other.id,
                attachment_id=identifier,
                request_id=str(uuid4()),
            )
        assert denied.value.status in {403, 404}
    with pytest.raises(RefusalError) as denied:
        services.create_upload(
            verified=tokens[3], organisation_id=other.id, body={}, request_id=str(uuid4())
        )
    assert denied.value.status in {403, 404}
    assert len(gateway.calls) == before


@pytest.mark.parametrize("restriction", ["banned", "kicked"])
def test_workspace_exclusion_refuses_presign_completion_and_download(world, gateway, restriction):
    org, workspace, members, tokens = world
    ticket = upload(world, gateway)
    identifier = ticket["attachmentId"]
    services.complete_upload(
        verified=tokens[3],
        organisation_id=org.id,
        attachment_id=identifier,
        request_id=str(uuid4()),
    )
    WorkspaceMemberRestriction.objects.create(
        workspace=workspace, membership=members[3], **{restriction: True}
    )
    before = len(gateway.calls)
    for operation in (
        lambda: services.create_upload(
            verified=tokens[3], organisation_id=org.id, body={}, request_id=str(uuid4())
        ),
        lambda: services.complete_upload(
            verified=tokens[3],
            organisation_id=org.id,
            attachment_id=identifier,
            request_id=str(uuid4()),
        ),
        lambda: services.get_attachment(
            verified=tokens[3], organisation_id=org.id, attachment_id=identifier
        ),
    ):
        with pytest.raises(RefusalError) as denied:
            operation()
        assert denied.value.status == 403
    assert len(gateway.calls) == before


def test_scoped_channel_and_dm_attachments_enforce_serving_verifier_complete_and_legacy_rules(
    world, gateway, settings, tmp_path
):
    import hashlib
    import json
    import secrets
    import tempfile
    import threading
    import urllib.parse
    from datetime import timedelta
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from pathlib import Path

    from django.db import IntegrityError

    from apps.media.models import Attachment
    from apps.media.storage_worker import DirectorySource, bind
    from apps.workspaces import governance, iam
    from apps.workspaces.models import Channel, ResourcePolicy, ResourcePolicyRule
    from config.workspace_features import media_gateway_socket, media_room_verifier_url
    from room_access.clients import LiveKit, Matrix
    from room_access.rooms import POLICY
    from room_access.server import make_webhook_server

    org, workspace, members, tokens = world
    auditor_role = iam.create_role(
        verified=tokens[0],
        organisation_id=org.id,
        data={
            "name": "Auditors",
            "slug": "auditors",
            "position": 10,
            "permissions": ["view_audit_log"],
        },
        request_id=str(uuid4()),
    )
    iam.assign_roles(
        verified=tokens[0],
        organisation_id=org.id,
        membership_id=members[2].id,
        role_ids=[auditor_role["id"]],
        request_id=str(uuid4()),
    )

    policy = ResourcePolicy.objects.create(workspace=workspace, visibility="restricted")
    uploader_rule = ResourcePolicyRule.objects.create(
        policy=policy, kind="allow_member", membership=members[3]
    )
    private_channel = Channel.objects.create(
        workspace=workspace,
        name="Private board",
        kind="text",
        lifecycle="active",
        position=0,
        policy_mode="explicit",
        explicit_policy=policy,
    )

    matrix_domain = "matrix.kodera.test"
    agent_mxid = f"@kodera-agent:{matrix_domain}"
    admin_token = "synapse-admin-" + secrets.token_hex(8)
    dm_room = f"!dmSecretRoom42:{matrix_domain}"
    governed_channel_room = f"!chanRoom99:{matrix_domain}"
    dm_joined_mxids = {
        f"@{tokens[3].subject.lower()}:{matrix_domain}",
        f"@{tokens[1].subject.lower()}:{matrix_domain}",
    }

    class FakeSynapseHandler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            if self.headers.get("Authorization") != f"Bearer {admin_token}":
                self._json(401, {"errcode": "M_UNKNOWN_TOKEN"})
                return
            prefix = "/_synapse/admin/v1/rooms/"
            if self.path.startswith(prefix) and self.path.endswith("/state"):
                encoded_room = self.path[len(prefix) : -len("/state")]
                target_room = urllib.parse.unquote(encoded_room)
                if target_room == dm_room:
                    state_events = [
                        {
                            "type": "m.room.member",
                            "state_key": mxid,
                            "sender": mxid,
                            "content": {"membership": "join"},
                        }
                        for mxid in sorted(dm_joined_mxids)
                    ]
                    self._json(200, {"state": state_events})
                    return
                if target_room == governed_channel_room:
                    self._json(
                        200,
                        {
                            "state": [
                                {
                                    "type": POLICY,
                                    "state_key": "",
                                    "sender": agent_mxid,
                                    "content": {"audience": "all", "read_only": False},
                                },
                                {
                                    "type": "m.room.member",
                                    "state_key": f"@{tokens[3].subject.lower()}:{matrix_domain}",
                                    "sender": agent_mxid,
                                    "content": {"membership": "join"},
                                },
                            ]
                        },
                    )
                    return
                self._json(404, {"errcode": "M_NOT_FOUND"})
                return
            self._json(404, {"errcode": "M_UNRECOGNIZED"})

        def _json(self, status: int, data: dict) -> None:
            raw = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            return

    synapse_srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeSynapseHandler)
    synapse_url = f"http://127.0.0.1:{synapse_srv.server_address[1]}"
    threading.Thread(target=synapse_srv.serve_forever, daemon=True).start()

    room_access_srv = make_webhook_server(
        "127.0.0.1",
        0,
        LiveKit("http://127.0.0.1:9", "lk-key", "lk-secret-" + "x" * 32),
        lambda _ev: None,
        matrix=Matrix(synapse_url, admin_token, timeout=2.0),
        agent_user=agent_mxid,
    )
    threading.Thread(target=room_access_srv.serve_forever, daemon=True).start()
    verifier_url = media_room_verifier_url(
        {
            "KODERA_MEDIA_ROOM_VERIFIER_URL": (
                f"http://127.0.0.1:{room_access_srv.server_address[1]}/internal/room-member"
            )
        }
    )
    settings.KODERA_MEDIA_ROOM_VERIFIER_URL = verifier_url

    try:
        with pytest.raises(RefusalError) as unscoped_refused:
            services.create_upload(
                verified=tokens[3],
                organisation_id=org.id,
                body={
                    "filename": "unscoped.pdf",
                    "contentType": "application/pdf",
                    "sizeBytes": 32,
                    "sha256": hashlib.sha256(b"unscoped").hexdigest(),
                },
                request_id=str(uuid4()),
            )
        assert unscoped_refused.value.status == 422

        with pytest.raises(RefusalError) as channel_as_dm_refused:
            services.create_upload(
                verified=tokens[3],
                organisation_id=org.id,
                body={
                    "filename": "spoof.pdf",
                    "contentType": "application/pdf",
                    "sizeBytes": 32,
                    "sha256": hashlib.sha256(b"spoof").hexdigest(),
                    "roomId": governed_channel_room,
                },
                request_id=str(uuid4()),
            )
        assert channel_as_dm_refused.value.status == 403

        channel_ticket = services.create_upload(
            verified=tokens[3],
            organisation_id=org.id,
            body={
                "filename": "board-notes.pdf",
                "contentType": "application/pdf",
                "sizeBytes": 64,
                "sha256": hashlib.sha256(secrets.token_bytes(64)).hexdigest(),
                "channelId": str(private_channel.id),
            },
            request_id=str(uuid4()),
        )
        dm_ticket = services.create_upload(
            verified=tokens[3],
            organisation_id=org.id,
            body={
                "filename": "dm-contract.pdf",
                "contentType": "application/pdf",
                "sizeBytes": 64,
                "sha256": hashlib.sha256(secrets.token_bytes(64)).hexdigest(),
                "roomId": dm_room,
            },
            request_id=str(uuid4()),
        )

        calls_before_owner_complete = len(gateway.calls)
        for target_id in (channel_ticket["attachmentId"], dm_ticket["attachmentId"]):
            with pytest.raises(RefusalError) as owner_complete_denied:
                services.complete_upload(
                    verified=tokens[0],
                    organisation_id=org.id,
                    attachment_id=target_id,
                    request_id=str(uuid4()),
                )
            assert owner_complete_denied.value.status == 403
        assert len(gateway.calls) == calls_before_owner_complete

        services.complete_upload(
            verified=tokens[3],
            organisation_id=org.id,
            attachment_id=channel_ticket["attachmentId"],
            request_id=str(uuid4()),
        )
        services.complete_upload(
            verified=tokens[3],
            organisation_id=org.id,
            attachment_id=dm_ticket["attachmentId"],
            request_id=str(uuid4()),
        )

        uploader_rule.delete()
        with pytest.raises(RefusalError) as removed_uploader_complete:
            services.complete_upload(
                verified=tokens[3],
                organisation_id=org.id,
                attachment_id=channel_ticket["attachmentId"],
                request_id=str(uuid4()),
            )
        assert removed_uploader_complete.value.status == 403
        ResourcePolicyRule.objects.create(policy=policy, kind="allow_member", membership=members[3])

        with pytest.raises(RefusalError) as owner_post_complete_dm:
            services.complete_upload(
                verified=tokens[0],
                organisation_id=org.id,
                attachment_id=dm_ticket["attachmentId"],
                request_id=str(uuid4()),
            )
        assert owner_post_complete_dm.value.status == 403

        assert (
            services.get_attachment(
                verified=tokens[3],
                organisation_id=org.id,
                attachment_id=channel_ticket["attachmentId"],
            )["id"]
            == channel_ticket["attachmentId"]
        )
        assert (
            services.get_attachment(
                verified=tokens[1],
                organisation_id=org.id,
                attachment_id=dm_ticket["attachmentId"],
            )["id"]
            == dm_ticket["attachmentId"]
        )

        with tempfile.TemporaryDirectory(dir="/tmp", prefix="k2b-ms-") as short_dir:
            sock_path = Path(short_dir) / "media.sock"
            secrets_dir = tmp_path / "media-secrets"
            secrets_dir.mkdir(mode=0o700)
            secret_file = secrets_dir / str(org.id)
            secret_file.write_text(
                json.dumps(
                    {
                        "endpoint": "https://s3.fr-par.scw.cloud",
                        "bucket": "kodera-media-test",
                        "region": "fr-par",
                        "accessKey": "SCWTESTACCESSKEY0001",
                        "secretKey": "synthetic-test-s3-secret-key-0000000001",
                        "synapseUrl": synapse_url,
                        "synapseToken": admin_token,
                        "synapseAgentUser": agent_mxid,
                    }
                ),
                encoding="utf-8",
            )
            secret_file.chmod(0o600)
            worker_srv = bind(sock_path, DirectorySource(secrets_dir))
            threading.Thread(target=worker_srv.serve_forever, daemon=True).start()
            try:
                settings.KODERA_MEDIA_ROOM_VERIFIER_URL = None
                settings.KODERA_MEDIA_GATEWAY_SOCKET = media_gateway_socket(
                    {"KODERA_MEDIA_GATEWAY_SOCKET": str(sock_path)}
                )
                real_gw = services.Gateway(settings.KODERA_MEDIA_GATEWAY_SOCKET)
                assert (
                    real_gw.verify_room_member(
                        organisation_id=org.id, room_id=dm_room, subject=tokens[1].subject
                    )
                    is True
                )
                assert (
                    real_gw.verify_room_member(
                        organisation_id=org.id, room_id=dm_room, subject=tokens[0].subject
                    )
                    is False
                )
                assert (
                    real_gw.verify_room_member(
                        organisation_id=org.id,
                        room_id=governed_channel_room,
                        subject=tokens[3].subject,
                    )
                    is False
                )
            finally:
                worker_srv.shutdown()
                worker_srv.server_close()
                settings.KODERA_MEDIA_GATEWAY_SOCKET = None
                settings.KODERA_MEDIA_ROOM_VERIFIER_URL = verifier_url

        audit_page = governance.admin_page(
            verified=tokens[2], organisation_id=org.id, kind="audit", query={"limit": "50"}
        )
        attachment_events = [
            entry
            for entry in audit_page["data"]
            if entry["action"].startswith("workspace.attachment.")
        ]
        assert len(attachment_events) == 4
        for entry in attachment_events:
            assert channel_ticket["attachmentId"] not in entry["target_urn"]
            assert dm_ticket["attachmentId"] not in entry["target_urn"]
            assert entry["target_urn"].startswith("urn:kodera:workspace-attachment:redacted:")

        calls_before = len(gateway.calls)
        for target_id in (channel_ticket["attachmentId"], dm_ticket["attachmentId"]):
            with pytest.raises(RefusalError) as denied:
                services.get_attachment(
                    verified=tokens[2], organisation_id=org.id, attachment_id=target_id
                )
            assert denied.value.status == 403
        with pytest.raises(RefusalError) as owner_dm_denied:
            services.get_attachment(
                verified=tokens[0], organisation_id=org.id, attachment_id=dm_ticket["attachmentId"]
            )
        assert owner_dm_denied.value.status == 403
        assert len(gateway.calls) == calls_before

        legacy_row = Attachment.objects.create(
            organisation=org,
            uploader=members[3],
            channel=None,
            room_id=None,
            filename="legacy-dm.pdf",
            content_type="application/pdf",
            size_bytes=28,
            sha256=hashlib.sha256(b"legacy-dm").hexdigest(),
            upload_expires_at=timezone.now() + timedelta(minutes=5),
            completed_at=timezone.now(),
        )
        assert services.get_attachment(
            verified=tokens[3], organisation_id=org.id, attachment_id=legacy_row.id
        )["id"] == str(legacy_row.id)
        for non_uploader in (tokens[0], tokens[1], tokens[2]):
            with pytest.raises(RefusalError) as legacy_get_denied:
                services.get_attachment(
                    verified=non_uploader, organisation_id=org.id, attachment_id=legacy_row.id
                )
            assert legacy_get_denied.value.status == 403
            with pytest.raises(RefusalError) as legacy_complete_denied:
                services.complete_upload(
                    verified=non_uploader,
                    organisation_id=org.id,
                    attachment_id=legacy_row.id,
                    request_id=str(uuid4()),
                )
            assert legacy_complete_denied.value.status == 403

        settings.KODERA_MEDIA_ROOM_VERIFIER_URL = None
        assert (
            services.get_attachment(
                verified=tokens[3], organisation_id=org.id, attachment_id=dm_ticket["attachmentId"]
            )["id"]
            == dm_ticket["attachmentId"]
        )
        with pytest.raises(RefusalError) as fail_closed:
            services.get_attachment(
                verified=tokens[1], organisation_id=org.id, attachment_id=dm_ticket["attachmentId"]
            )
        assert fail_closed.value.status == 403

        with pytest.raises(IntegrityError), transaction.atomic():
            Attachment.objects.filter(pk=channel_ticket["attachmentId"]).update(channel=None)
        with pytest.raises(IntegrityError), transaction.atomic():
            Attachment.objects.filter(pk=dm_ticket["attachmentId"]).update(
                room_id="!otherRoom:matrix.kodera.test"
            )
    finally:
        room_access_srv.shutdown()
        room_access_srv.server_close()
        synapse_srv.shutdown()
        synapse_srv.server_close()


def test_media_0003_attachment_scope_binding_reverses_and_reapplies_cleanly(django_db_blocker):
    from django.db.migrations.executor import MigrationExecutor
    from test_customer_persistence_migrations import empty_database, schema_objects

    with django_db_blocker.unblock(), empty_database() as target:
        executor = MigrationExecutor(target)
        executor.migrate([("media", "0003_attachment_scope_binding")])
        forward_schema = schema_objects(target)
        assert ("media_attachment", "media_attachment_delete_guard") in forward_schema[2]

        executor = MigrationExecutor(target)
        executor.migrate([("media", "0002_attachment_scope")])
        reversed_schema = schema_objects(target)
        assert ("media_attachment", "media_attachment_delete_guard") not in reversed_schema[2]

        executor = MigrationExecutor(target)
        executor.migrate([("media", "0003_attachment_scope_binding")])
        assert schema_objects(target) == forward_schema


def test_audio_companion_channel_upload_enforces_read_only_overrides_and_archive(world, gateway):
    import hashlib

    from apps.workspaces import governance, iam
    from apps.workspaces.channel_access import LISTEN_ONLY, READ_ONLY
    from apps.workspaces.models import Channel, ResourcePolicy, ResourcePolicyRule

    org, workspace, members, tokens = world
    default_pol = ResourcePolicy.objects.create(workspace=workspace, visibility="organisation")
    workspace.default_policy = default_pol
    workspace.save(update_fields=["default_policy", "updated_at"])

    audio_policy = ResourcePolicy.objects.create(workspace=workspace, visibility="organisation")
    for cap in LISTEN_ONLY:
        ResourcePolicyRule.objects.create(
            policy=audio_policy, kind="deny_capability", capability=cap
        )
    audio_chan = Channel.objects.create(
        workspace=workspace,
        name="Stage Lounge",
        kind="audio",
        lifecycle="active",
        position=5,
        policy_mode="explicit",
        explicit_policy=audio_policy,
    )
    payload = {
        "channelId": str(audio_chan.id),
        "filename": "notes.pdf",
        "contentType": "application/pdf",
        "sizeBytes": 128,
        "sha256": hashlib.sha256(b"audio-companion").hexdigest(),
    }

    # 1. Active audio channel with listen_only=True and read_only=False admits member file.upload!
    ticket = services.create_upload(
        verified=tokens[3], organisation_id=org.id, body=payload, request_id=str(uuid4())
    )
    completed = services.complete_upload(
        verified=tokens[3],
        organisation_id=org.id,
        attachment_id=ticket["attachmentId"],
        request_id=str(uuid4()),
    )
    assert completed["filename"] == "notes.pdf"

    # 2. Turning read_only=True on the audio channel denies org_member uploads, admits org_owner,
    #    and admits org_member once granted `allow: ["message.post"]` role override!
    for cap in READ_ONLY:
        ResourcePolicyRule.objects.create(
            policy=audio_policy, kind="deny_capability", capability=cap
        )
    with pytest.raises(RefusalError) as ro_denied:
        services.create_upload(
            verified=tokens[3], organisation_id=org.id, body=payload, request_id=str(uuid4())
        )
    assert ro_denied.value.status == 403

    owner_ticket = services.create_upload(
        verified=tokens[0], organisation_id=org.id, body=payload, request_id=str(uuid4())
    )
    assert owner_ticket["attachmentId"]

    poster_role = iam.create_role(
        verified=tokens[0],
        organisation_id=org.id,
        data={
            "name": "CompanionPoster",
            "slug": "companion-poster",
            "position": 10,
            "permissions": [],
        },
        request_id=str(uuid4()),
    )
    iam.assign_roles(
        verified=tokens[0],
        organisation_id=org.id,
        membership_id=members[3].id,
        role_ids=[poster_role["id"]],
        request_id=str(uuid4()),
    )
    governance.overrides(
        verified=tokens[0],
        organisation_id=org.id,
        channel_id=audio_chan.id,
        data=[{"role_id": poster_role["id"], "allow": ["message.post"], "deny": []}],
        request_id=str(uuid4()),
    )
    overridden_ticket = services.create_upload(
        verified=tokens[3], organisation_id=org.id, body=payload, request_id=str(uuid4())
    )
    assert overridden_ticket["attachmentId"]

    # 3. Active audio attachment is readable while active, whereas archiving the audio channel
    #    denies BOTH upload AND read (`file.read` via `may_perform`) to everyone — while an
    #    archived text channel preserves attachment read access!
    from uuid import UUID

    text_chan = Channel.objects.create(
        workspace=workspace,
        kind="text",
        name="notes-archive",
        position=51,
        policy_mode="inherit",
        lifecycle="active",
        room_state="ready",
    )
    text_payload = {
        **payload,
        "channelId": str(text_chan.id),
        "sha256": hashlib.sha256(b"text-archive").hexdigest(),
    }
    text_ticket = services.create_upload(
        verified=tokens[3], organisation_id=org.id, body=text_payload, request_id=str(uuid4())
    )
    services.complete_upload(
        verified=tokens[3],
        organisation_id=org.id,
        attachment_id=text_ticket["attachmentId"],
        request_id=str(uuid4()),
    )

    # Active audio attachment is readable before archiving.
    active_read = services.get_attachment(
        verified=tokens[3],
        organisation_id=org.id,
        attachment_id=UUID(ticket["attachmentId"]),
    )
    assert active_read["id"] == ticket["attachmentId"]

    Channel.objects.filter(pk__in=[audio_chan.id, text_chan.id]).update(lifecycle="archived")
    for caller_tok in (tokens[0], tokens[3]):
        with pytest.raises(RefusalError) as archived_denied:
            services.create_upload(
                verified=caller_tok, organisation_id=org.id, body=payload, request_id=str(uuid4())
            )
        assert archived_denied.value.status == 403
        with pytest.raises(RefusalError) as archived_read_denied:
            services.get_attachment(
                verified=caller_tok,
                organisation_id=org.id,
                attachment_id=UUID(ticket["attachmentId"]),
            )
        assert archived_read_denied.value.status == 403

    # Archived text channel attachment remains readable.
    archived_text_read = services.get_attachment(
        verified=tokens[3],
        organisation_id=org.id,
        attachment_id=UUID(text_ticket["attachmentId"]),
    )
    assert archived_text_read["id"] == text_ticket["attachmentId"]
