"""H2.2 acceptance suite: streaming ZIP bounds, magic-byte MIME, zero-privilege member matching,
zero-mutation dry-run, idempotent Matrix room/thread replay, and bounded coexistence bridges."""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import io
import json
import struct
import time
import uuid
import zipfile
from datetime import timedelta
from typing import Any

import pytest
from customer_http_fixtures import configure, http_signer as http_signer, token, trust_entry
from django.db import IntegrityError, connection
from django.test import Client
from django.utils import timezone
from test_extension_import_parsers import archive
from test_intake_writer_role import INSUFFICIENT_PRIVILEGE, acting_as, refused
from workspace_documents.test_services import native_engine as native_engine
from workspace_safety.test_moderation import world as world

from apps.audit.models import AuditEvent
from apps.docs.models import Collection, CollectionRow, Document
from apps.extensions import coexistence, import_parsers, imports, member_matching, retention
from apps.extensions.models import (
    CoexistenceBridge,
    CoexistenceReplayGuard,
    ImportBatch,
    ImportedObject,
    WorkspaceCutoff,
)
from apps.extensions.wire import ExtensionRefusedError
from apps.identity.models import Identity, User
from apps.media import outbound
from apps.media.models import Attachment
from apps.orgs.models import Membership
from apps.workspaces.models import Category, Channel, WorkspaceModerator, WorkspaceQuota
from core.db.api_database_boundary import assert_writer_grants
from core.db.api_writer_role import grant_statements
from core.idempotency.models import IdempotencyRecord
from core.sealing import SealError, unseal

pytestmark = pytest.mark.django_db(transaction=True)


def _forge_zip_declared_sizes(
    raw_zip: bytes, forged_size: int = 64, *, forge_crc: bytes | None = None
) -> bytes:
    """Rewrite both local file header and central directory uncompressed sizes (and optional CRC)."""
    buf = bytearray(raw_zip)
    pos = 0
    while True:
        idx = buf.find(b"PK\x03\x04", pos)
        if idx < 0 or idx + 30 > len(buf):
            break
        if forge_crc is not None:
            struct.pack_into("<I", buf, idx + 14, binascii.crc32(forge_crc))
        struct.pack_into("<I", buf, idx + 22, forged_size)
        name_len, extra_len = struct.unpack_from("<HH", buf, idx + 26)
        comp_size = struct.unpack_from("<I", buf, idx + 18)[0]
        pos = idx + 30 + name_len + extra_len + comp_size

    pos = 0
    while True:
        idx = buf.find(b"PK\x01\x02", pos)
        if idx < 0 or idx + 46 > len(buf):
            break
        if forge_crc is not None:
            struct.pack_into("<I", buf, idx + 16, binascii.crc32(forge_crc))
        struct.pack_into("<I", buf, idx + 24, forged_size)
        name_len, extra_len, comment_len = struct.unpack_from("<HHH", buf, idx + 28)
        pos = idx + 46 + name_len + extra_len + comment_len
    return bytes(buf)


def _create_channel(workspace: Any, *, name: str, is_confidential: bool = False) -> Channel:
    category = Category.objects.filter(workspace=workspace).first()
    if category is None:
        category = Category.objects.create(workspace=workspace, name="General", position=0)
    pos = Channel.objects.filter(workspace=workspace).count()
    return Channel.objects.create(
        workspace=workspace,
        category=category,
        kind="text",
        name=name,
        position=pos,
        lifecycle="active",
        is_confidential=is_confidential,
    )


class FakeSynapseTransport:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict[str, Any]]] = []

    def send_message(self, *, room_id: str, txn_id: str, content: dict[str, Any]) -> str:
        self.calls.append((room_id, txn_id, content))
        return f"$evt-{len(self.calls):04d}"


# ---------------------------------------------------------------------------
# 1. Streaming 64 KiB Decompression & Magic-Byte MIME Verification
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("with_forged_crc", [False, True])
def test_streaming_decompression_defeats_forged_file_size_single_entry_bomb(
    with_forged_crc: bool,
) -> None:
    # 3 MiB repetitive payload compresses to ~3 KiB under DEFLATE, exceeding MAX_FILE (2 MiB).
    bomb_payload = (b"A" * 1024 + b"\n") * 3072
    raw = archive({"Studio/Notes.md": bomb_payload}, compression=zipfile.ZIP_DEFLATED)
    assert len(raw) < 32 * 1024
    forged = _forge_zip_declared_sizes(
        raw, forged_size=64, forge_crc=bomb_payload[:64] if with_forged_crc else None
    )
    with zipfile.ZipFile(io.BytesIO(forged)) as zf:
        assert zf.infolist()[0].file_size == 64

    with pytest.raises(ExtensionRefusedError, match="import_archive_bound") as exc_info:
        import_parsers.archive(forged)
    assert exc_info.value.status == 413

    with pytest.raises(ExtensionRefusedError, match="import_archive_bound"):
        import_parsers.archive(io.BytesIO(forged))


def test_streaming_decompression_defeats_forged_multi_entry_archive_wide_bomb() -> None:
    # 22 honest entries * 1.8 MiB = 39.6 MiB (<= MAX_EXPANDED = 40 MiB), plus a 23rd entry whose
    # central-directory file_size is forged to 64 bytes while actually expanding 1.8 MiB (41.4 MiB > 40 MiB).
    rng_block = hashlib.sha256(b"seed").digest()
    blocks = [hashlib.sha256(rng_block + i.to_bytes(4, "big")).digest() * 64 for i in range(900)]
    chunk_1_8_mib = (b"".join(blocks) * 2)[: int(1.8 * 1024 * 1024)]

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for idx in range(23):
            zf.writestr(f"Page_{idx:02d}.md", chunk_1_8_mib)
    raw_bytes = bytearray(buf.getvalue())
    assert len(raw_bytes) < import_parsers.MAX_ARCHIVE

    # Forge ONLY the final entry's local & central directory `file_size` to 64 bytes so pre-scan
    # sums to ~39.6 MiB (< 40 MiB), forcing the streaming 64 KiB counter to catch > 40 MiB mid-entry!
    last_local = raw_bytes.rfind(b"PK\x03\x04")
    last_central = raw_bytes.rfind(b"PK\x01\x02")
    struct.pack_into("<I", raw_bytes, last_local + 22, 64)
    struct.pack_into("<I", raw_bytes, last_central + 24, 64)

    with pytest.raises(ExtensionRefusedError, match="import_archive_bound") as exc_info:
        import_parsers.archive(io.BytesIO(bytes(raw_bytes)))
    assert exc_info.value.status == 413


def test_magic_byte_mime_validation_admits_valid_headers_and_rejects_disguised_payloads() -> None:
    valid_vectors = [
        ("spec.pdf", b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n", "application/pdf"),
        ("shot.png", b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR", "image/png"),
        ("photo.jpg", b"\xff\xd8\xff\xe0\x00\x10JFIF\x00", "image/jpeg"),
        ("anim.gif", b"GIF89a\x01\x00\x01\x00\x00\x00\x00;", "image/gif"),
        ("clip.webp", b"RIFF\x14\x00\x00\x00WEBPVP8 \x08\x00\x00\x00", "image/webp"),
        ("voice.ogg", b"OggS\x00\x02\x00\x00\x00\x00\x00\x00", "audio/ogg"),
        ("screen.webm", b"\x1a\x45\xdf\xa3\x93\x42\x82\x88webm", "video/webm"),
    ]
    for filename, payload, expected_mime in valid_vectors:
        assert import_parsers.verify_asset_magic(filename, payload) == expected_mime

    disguised_vectors = [
        ("avatar.png", b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"),
        ("report.pdf", b"<!DOCTYPE html><html><body><script>steal()</script></body></html>"),
        ("polyglot.pdf", b"%PDF-1.7\n<html><script>evil()</script></html>"),
        ("evil.svg", b"\x89PNG\r\n\x1a\n"),
        ("payload.html", b"%PDF-1.7\n"),
        ("clip.webp", b"RIFF\x14\x00\x00\x00WAVEfmt "),
    ]
    for filename, payload in disguised_vectors:
        with pytest.raises(ExtensionRefusedError, match="import_asset_"):
            import_parsers.verify_asset_magic(filename, payload)

    bad_archive = archive(
        {
            "Studio.md": "# Studio\nSafe text",
            "Studio/disguised.png": b"<html><script>bad()</script></html>",
        }
    )
    with pytest.raises(ExtensionRefusedError, match="import_asset_mime_mismatch"):
        import_parsers.parse("notion", bad_archive)


def test_enriched_slack_discord_threads_and_notion_code_callouts_and_select_columns() -> None:
    slack_raw = archive(
        {
            "channels.json": json.dumps(
                [{"id": "C01", "name": "general", "purpose": {"value": "Main"}}]
            ),
            "users.json": json.dumps(
                [
                    {
                        "id": "U01",
                        "name": "alice",
                        "is_owner": True,
                        "profile": {"display_name": "Alice", "email": "  Alice@Example.ORG "},
                    },
                    {
                        "id": "UBOT",
                        "name": "deploybot",
                        "is_bot": True,
                        "profile": {"display_name": "Bot", "email": "bot@example.org"},
                    },
                ]
            ),
            "general/2026-11-20.json": json.dumps(
                [
                    {
                        "ts": "1700000001.000100",
                        "thread_ts": "1700000001.000100",
                        "user": "U01",
                        "text": "Root message",
                    },
                    {
                        "ts": "1700000002.000200",
                        "thread_ts": "1700000001.000100",
                        "user": "U01",
                        "text": "Thread reply",
                    },
                ]
            ),
        }
    )
    slack_parsed = import_parsers.parse("slack", slack_raw)
    assert len(slack_parsed.channels) == 1
    assert slack_parsed.channels[0].name == "general"
    assert len(slack_parsed.messages) == 2
    assert slack_parsed.messages[0].thread_parent_key is None
    assert slack_parsed.messages[1].thread_parent_key == "slack:message:C01:1700000001.000100"
    users_by_id = {u.external_id: u for u in slack_parsed.external_users}
    assert users_by_id["U01"].email == "alice@example.org"
    assert users_by_id["U01"].had_external_admin_privilege is True
    assert users_by_id["UBOT"].is_bot is True
    assert users_by_id["UBOT"].email is None

    discord_raw = json.dumps(
        {
            "channel": {"id": "9001", "name": "dev"},
            "messages": [
                {
                    "id": "100",
                    "timestamp": "2026-11-20T10:00:00Z",
                    "content": "Parent",
                    "author": {
                        "id": "501",
                        "name": "GuildAdmin",
                        "email": "admin@example.org",
                        "permissions": "8",
                    },
                },
                {
                    "id": "101",
                    "timestamp": "2026-11-20T10:01:00Z",
                    "content": "Child reply",
                    "reference": {"messageId": "100"},
                    "author": {"id": "501", "name": "GuildAdmin"},
                },
            ],
        }
    ).encode("utf-8")
    discord_parsed = import_parsers.parse("discord", discord_raw)
    assert discord_parsed.messages[0].thread_parent_key is None
    assert discord_parsed.messages[1].thread_parent_key == "discord:message:9001:100"
    assert discord_parsed.external_users[0].had_external_admin_privilege is True

    notion_raw = archive(
        {
            "Guide.md": (
                "# Architecture\n"
                "<aside>Important callout <script>evil()</script></aside>\n"
                "```python\n"
                "def greet(x: int) -> int:\n"
                "    return x + 1\n"
                "```\n"
            ),
            "Guide/Roadmap.csv": (
                "Task,Status,Points\nSpec,Todo,3\nBuild,In Progress,5\nVerify,Todo,2\nShip,Done,1\n"
            ),
        }
    )
    notion_parsed = import_parsers.parse("notion", notion_raw)
    by_key = {item.external_key: item for item in notion_parsed.items}
    guide_md = by_key["notion:page:Guide.md"].markdown
    assert "# Architecture" in guide_md
    assert "> Important callout" in guide_md
    assert "```python" in guide_md and "def greet" in guide_md
    assert "<script>" not in guide_md and "evil()" not in guide_md
    roadmap = by_key["notion:page:Guide/Roadmap.csv"]
    assert roadmap.properties is not None
    assert [p["type"] for p in roadmap.properties] == ["text", "select", "number"]
    option_labels = {opt["id"]: opt["label"] for opt in roadmap.properties[1]["options"]}
    row_values = by_key["notion:row:Guide/Roadmap.csv:1"].values
    assert row_values is not None
    assert option_labels[row_values["c1"]] == "Todo"


# ---------------------------------------------------------------------------
# 2. Verified-Email Member Matching — ZERO Privilege Escalation
# ---------------------------------------------------------------------------


def test_member_matching_preserves_local_roles_and_never_escalates_or_creates_accounts(
    world,
) -> None:
    org, workspace, members, _tokens = world
    ordinary_member = members[3]
    assert ordinary_member.role == "org_member"
    member_identity = Identity.objects.get(
        organisation_id=org.id, user_id=ordinary_member.user_id, enabled=True
    )
    member_identity.email = "ordinary.member@acme.example"
    member_identity.save(update_fields=["email"])

    users_before = User.objects.count()
    identities_before = Identity.objects.count()
    moderators_before = WorkspaceModerator.objects.filter(workspace=workspace).count()

    external_users = (
        import_parsers.ImportedExternalUser(
            external_id="U_EXT_PRIMARY_OWNER",
            display_name="Escalation Attempt",
            email="  ORDINARY.MEMBER@acme.example ",
            is_bot=False,
            had_external_admin_privilege=True,
        ),
        import_parsers.ImportedExternalUser(
            external_id="U_UNKNOWN_ADMIN",
            display_name="Outside Admin",
            email="stranger.owner@external.example",
            is_bot=False,
            had_external_admin_privilege=True,
        ),
        import_parsers.ImportedExternalUser(
            external_id="U_BOT",
            display_name="Slackbot",
            email="ordinary.member@acme.example",
            is_bot=True,
            had_external_admin_privilege=False,
        ),
    )
    outcome = member_matching.match_external_users(
        organisation_id=org.id, external_users=external_users
    )

    assert outcome.matched_count == 1
    assert outcome.unmatched_count == 2
    assert outcome.external_admin_privilege_ignored is True
    mappings = {m.external_id: m for m in outcome.mappings}
    assert mappings["U_EXT_PRIMARY_OWNER"].matched_membership_id == ordinary_member.id
    assert mappings["U_EXT_PRIMARY_OWNER"].local_role_preserved is True
    assert mappings["U_UNKNOWN_ADMIN"].matched_membership_id is None
    assert mappings["U_BOT"].matched_membership_id is None

    ordinary_member.refresh_from_db()
    assert ordinary_member.role == "org_member"
    assert User.objects.count() == users_before
    assert Identity.objects.count() == identities_before
    assert WorkspaceModerator.objects.filter(workspace=workspace).count() == moderators_before
    assert (
        member_matching.inert_author_attribution("slack", "U_UNKNOWN_ADMIN", "Outside Admin")
        == "Imported author: Outside Admin (Slack U_UNKNOWN_ADMIN)"
    )


# ---------------------------------------------------------------------------
# 3 & 4. Zero-Mutation Dry-Run Simulation & Idempotent Matrix History Replay
# ---------------------------------------------------------------------------


def test_dry_run_preview_performs_zero_writes_and_emits_quota_and_confidential_warnings(
    world, native_engine
) -> None:
    org, workspace, _members, tokens = world
    confidential_ch = _create_channel(workspace, name="secret-ops", is_confidential=True)

    # Set tight pages quota so dry-run detects quota_headroom_exceeded without mutating.
    WorkspaceQuota.objects.filter(workspace=workspace).update(pages=1)

    slack_zip = archive(
        {
            "channels.json": json.dumps(
                [
                    {"id": "C1", "name": "secret-ops"},
                    {"id": "C2", "name": "brand-new-room"},
                ]
            ),
            "users.json": json.dumps(
                [
                    {
                        "id": "U1",
                        "name": "ext_owner",
                        "is_primary_owner": True,
                        "profile": {"display_name": "Ext Owner", "email": "nobody@acme.example"},
                    }
                ]
            ),
            "secret-ops/2026-11-20.json": json.dumps(
                [
                    {
                        "ts": "1700000100.000001",
                        "user": "U1",
                        "text": "Hello",
                        "files": [{"url_private": "https://files.slack.com/x.bin"}],
                    },
                    {
                        "ts": "1700000101.000002",
                        "thread_ts": "1700000100.000001",
                        "user": "U1",
                        "text": "Reply in thread",
                    },
                ]
            ),
        }
    )

    # Ordinary member (`tokens[3]`) is refused 403.
    with pytest.raises(ExtensionRefusedError, match="owner_or_admin") as denied:
        imports.preview(verified=tokens[3], organisation_id=org.id, source="slack", raw=slack_zip)
    assert denied.value.status == 403

    batches_before = ImportBatch.objects.count()
    objs_before = ImportedObject.objects.count()
    docs_before = Document.objects.count()
    cols_before = Collection.objects.count()
    audits_before = AuditEvent.objects.count()
    idem_before = IdempotencyRecord.objects.count()

    report = imports.execute(
        verified=tokens[0],
        organisation_id=org.id,
        source="slack",
        raw=slack_zip,
        dry_run=True,
        channel_map={"C1": confidential_ch.id},
    )
    assert report["dry_run"] is True
    assert report["counts"] == {
        "channels_total": 2,
        "channels_existing": 0,
        "channels_to_create": 1,
        "messages_total": 2,
        "thread_replies_total": 1,
        "docs_pages_total": 0,
        "collections_total": 0,
        "collection_rows_total": 0,
        "members_matched": 0,
        "members_unmatched": 1,
        "already_imported_reused": 0,
        "omitted_assets": 1,
    }
    assert set(report["warnings"]) == {
        "external_admin_privilege_ignored",
        "confidential_target_channel_skipped",
        "unsupported_assets_omitted",
    }

    notion_zip = archive(
        {
            "PageA.md": "# Page A\nBody",
            "PageA/Table.csv": "Name,Done\nRow1,true\nRow2,false\n",
        }
    )
    notion_report = imports.preview(
        verified=tokens[0],
        organisation_id=org.id,
        source="notion",
        raw=notion_zip,
    )
    assert notion_report["dry_run"] is True
    assert notion_report["counts"]["docs_pages_total"] == 2
    assert notion_report["counts"]["collections_total"] == 1
    assert notion_report["counts"]["collection_rows_total"] == 2
    assert "quota_headroom_exceeded" in notion_report["warnings"]

    assert ImportBatch.objects.count() == batches_before
    assert ImportedObject.objects.count() == objs_before
    assert Document.objects.count() == docs_before
    assert Collection.objects.count() == cols_before
    assert AuditEvent.objects.count() == audits_before
    assert IdempotencyRecord.objects.count() == idem_before


def test_idempotent_matrix_replay_threads_confidential_refusal_and_select_collection_import(
    world, native_engine
) -> None:
    org, workspace, _members, tokens = world
    plain_ch = _create_channel(workspace, name="general", is_confidential=False)
    conf_ch = _create_channel(workspace, name="classified", is_confidential=True)

    slack_zip = archive(
        {
            "channels.json": json.dumps([{"id": "C1", "name": "general"}]),
            "users.json": json.dumps(
                [{"id": "U1", "name": "alice", "profile": {"display_name": "Alice"}}]
            ),
            "general/2026-11-20.json": json.dumps(
                [
                    {"ts": "1700000200.000001", "user": "U1", "text": "Root post"},
                    {
                        "ts": "1700000205.000002",
                        "thread_ts": "1700000200.000001",
                        "user": "U1",
                        "text": "Threaded follow-up",
                    },
                ]
            ),
        }
    )

    synapse = FakeSynapseTransport()
    rooms = {plain_ch.id: "!plain:acme.kodera.io", conf_ch.id: "!conf:acme.kodera.io"}

    # Confidential channel target MUST be refused with 403 and zero Synapse calls.
    with pytest.raises(
        ExtensionRefusedError, match="import_confidential_channel_refused"
    ) as refused_conf:
        imports.execute(
            verified=tokens[0],
            organisation_id=org.id,
            source="slack",
            raw=slack_zip,
            channel_map={"C1": conf_ch.id},
            room_map=rooms,
            matrix_transport=synapse,
        )
    assert refused_conf.value.status == 403
    assert synapse.calls == []

    # Replay into non-confidential channel succeeds with deterministic txn_id and m.thread relation.
    first = imports.execute(
        verified=tokens[0],
        organisation_id=org.id,
        source="slack",
        raw=slack_zip,
        channel_map={"C1": plain_ch.id},
        room_map=rooms,
        matrix_transport=synapse,
    )
    assert first["replayed_messages"] == 2
    assert first["reused_messages"] == 0
    assert len(synapse.calls) == 2

    root_room, root_txn, root_content = synapse.calls[0]
    reply_room, reply_txn, reply_content = synapse.calls[1]
    expected_root_txn = imports.deterministic_matrix_txn_id(
        workspace.id, "slack", "slack:message:C1:1700000200.000001"
    )
    expected_reply_txn = imports.deterministic_matrix_txn_id(
        workspace.id, "slack", "slack:message:C1:1700000205.000002"
    )
    assert root_txn == expected_root_txn
    assert reply_txn == expected_reply_txn
    assert root_room == reply_room == "!plain:acme.kodera.io"
    assert "m.relates_to" not in root_content
    assert reply_content["m.relates_to"] == {
        "rel_type": "m.thread",
        "event_id": "$evt-0001",
    }

    # Re-running the exact same archive + channel map is 100% idempotent (zero new Synapse calls).
    second = imports.execute(
        verified=tokens[0],
        organisation_id=org.id,
        source="slack",
        raw=slack_zip,
        channel_map={"C1": plain_ch.id},
        room_map=rooms,
        matrix_transport=synapse,
    )
    assert second["replayed_messages"] == 0
    assert second["reused_messages"] == 2
    assert len(synapse.calls) == 2

    # Notion CSV with `select` column imports cleanly into native Collection + CollectionRow.
    notion_zip = archive(
        {
            "Board.csv": "Item,Stage\nDesign,Review\nCode,Done\nTest,Review\nDeploy,Todo\n",
        }
    )
    notion_res = imports.execute(
        verified=tokens[0],
        organisation_id=org.id,
        source="notion",
        raw=notion_zip,
    )
    assert notion_res["state"] == "complete"
    assert Collection.objects.filter(workspace=workspace, title="Board").exists()
    assert CollectionRow.objects.filter(collection__workspace=workspace).count() == 4


# ---------------------------------------------------------------------------
# 5. Live Coexistence Bridge Security Invariants, HTTP Endpoints, Role & Erasure
# ---------------------------------------------------------------------------


def _sign_coexistence(secret: str, ts: int, raw_body: bytes) -> dict[str, str]:
    sig = hmac.new(
        secret.encode("utf-8"),
        f"{ts}.".encode("ascii") + raw_body,
        hashlib.sha256,
    ).hexdigest()
    return {
        "X-Kodera-Coexistence-Timestamp": str(ts),
        "X-Kodera-Coexistence-Signature": f"v1={sig}",
    }


def test_coexistence_bridge_sealing_aad_hmac_loop_guards_confidential_and_egress(
    world, monkeypatch
) -> None:
    org, workspace, members, tokens = world
    plain_ch = _create_channel(workspace, name="bridge-general", is_confidential=False)
    conf_ch = _create_channel(workspace, name="bridge-secret", is_confidential=True)
    secret = "s" * 36

    monkeypatch.setattr(
        outbound,
        "target",
        lambda url, *, https_only=True: outbound.Target(
            url=url, scheme="https", host="hooks.example.org", port=443, path="/coex"
        ),
    )

    # Confidential channel bridge creation MUST fail with 403.
    with pytest.raises(
        ExtensionRefusedError, match="coexistence_confidential_channel_refused"
    ) as conf_err:
        coexistence.create_bridge(
            verified=tokens[1],
            organisation_id=org.id,
            channel_id=conf_ch.id,
            source="slack",
            external_workspace_id="T01",
            external_channel_id="C01",
            outbound_endpoint="https://hooks.example.org/coex",
            signing_secret=secret,
        )
    assert conf_err.value.status == 403

    # Admin (`tokens[1]`, `members[1]`) creates bridge on non-confidential channel.
    bridge = coexistence.create_bridge(
        verified=tokens[1],
        organisation_id=org.id,
        channel_id=plain_ch.id,
        source="slack",
        external_workspace_id="T01",
        external_channel_id="C01",
        outbound_endpoint="https://hooks.example.org/coex",
        signing_secret=secret,
    )

    # Verify exact AAD binding (`b"kodera-coexistence-v1:" + org_id.bytes + bridge_id.bytes`).
    key = coexistence.coexistence_seal_key()
    expected_aad = b"kodera-coexistence-v1:" + org.id.bytes + bridge.id.bytes
    assert unseal(key, expected_aad, bytes(bridge.sealed_signing_secret)) == secret.encode("utf-8")
    with pytest.raises(SealError):
        unseal(
            key,
            b"kodera-coexistence-v1:" + uuid.uuid4().bytes + bridge.id.bytes,
            bytes(bridge.sealed_signing_secret),
        )

    synapse = FakeSynapseTransport()
    now_ts = 1_795_000_000

    # Invariant 1: Stale timestamp & invalid signature rejected BEFORE JSON parsing (malformed JSON returns 401, not 400).
    with pytest.raises(ExtensionRefusedError, match="coexistence_timestamp_stale") as stale_err:
        coexistence.receive_webhook(
            bridge_id=bridge.id,
            raw_body=b"{not-valid-json",
            headers=_sign_coexistence(secret, now_ts - 301, b"{not-valid-json"),
            now_ts=now_ts,
            matrix_transport=synapse,
            room_id="!coex:acme.kodera.io",
        )
    assert stale_err.value.status == 401

    with pytest.raises(ExtensionRefusedError, match="coexistence_signature_invalid") as sig_err:
        coexistence.receive_webhook(
            bridge_id=bridge.id,
            raw_body=b"{not-valid-json",
            headers={
                "X-Kodera-Coexistence-Timestamp": str(now_ts),
                "X-Kodera-Coexistence-Signature": "v1=" + "0" * 64,
            },
            now_ts=now_ts,
            matrix_transport=synapse,
            room_id="!coex:acme.kodera.io",
        )
    assert sig_err.value.status == 401

    # Valid inbound human message delivers once, then refuses replay with 409 (`coexistence_event_replayed`).
    inbound_payload = json.dumps(
        {
            "event_id": "Ev001",
            "team_id": "T01",
            "event": {
                "type": "message",
                "channel": "C01",
                "user": "U_EXT",
                "author_name": "Camille",
                "ts": "1795000000.000100",
                "text": "Bonjour depuis Slack",
            },
        }
    ).encode("utf-8")
    receipt1 = coexistence.receive_webhook(
        bridge_id=bridge.id,
        raw_body=inbound_payload,
        headers=_sign_coexistence(secret, now_ts, inbound_payload),
        now_ts=now_ts,
        matrix_transport=synapse,
        room_id="!coex:acme.kodera.io",
    )
    assert receipt1["accepted"] is True
    assert len(synapse.calls) == 1

    with pytest.raises(ExtensionRefusedError, match="coexistence_event_replayed") as dup_err:
        coexistence.receive_webhook(
            bridge_id=bridge.id,
            raw_body=inbound_payload,
            headers=_sign_coexistence(secret, now_ts, inbound_payload),
            now_ts=now_ts,
            matrix_transport=synapse,
            room_id="!coex:acme.kodera.io",
        )
    assert dup_err.value.status == 409
    assert len(synapse.calls) == 1

    # Invariant 2: Anti-echo loop guards (bot_id, bot_message, X-Kodera-Bridge-Origin, kodera_bridge_id, outbound hash, @kodera-agent).
    for echo_event, extra_header in [
        ({"type": "message", "channel": "C01", "bot_id": "B01", "text": "bot"}, {}),
        ({"type": "message", "channel": "C01", "subtype": "bot_message", "text": "bot"}, {}),
        (
            {
                "type": "message",
                "channel": "C01",
                "kodera_bridge_id": str(bridge.id),
                "text": "loop",
            },
            {},
        ),
        (
            {"type": "message", "channel": "C01", "user": "U2", "text": "header-loop"},
            {"X-Kodera-Bridge-Origin": str(bridge.id)},
        ),
    ]:
        body_bytes = json.dumps(
            {"event_id": f"Ev-{uuid.uuid4().hex[:8]}", "team_id": "T01", "event": echo_event}
        ).encode()
        hdrs = {**_sign_coexistence(secret, now_ts, body_bytes), **extra_header}
        with pytest.raises(ExtensionRefusedError, match="coexistence_echo_") as echo_err:
            coexistence.receive_webhook(
                bridge_id=bridge.id,
                raw_body=body_bytes,
                headers=hdrs,
                now_ts=now_ts,
                matrix_transport=synapse,
                room_id="!coex:acme.kodera.io",
            )
        assert echo_err.value.status == 409
    assert len(synapse.calls) == 1

    # Outbound forward stamps X-Kodera-Bridge-Origin, uses outbound.request(pool="webhook"), refuses @kodera-agent,
    # and records outbound SHA-256 so an echoed inbound copy is refused!
    outbound_calls: list[dict[str, Any]] = []

    class FakeConn:
        def close(self) -> None:
            pass

    class FakeResp:
        status = 200

        def read(self, _n: int = 0) -> bytes:
            return b"ok"

        def close(self) -> None:
            pass

    def fake_outbound_request(target_arg: Any, **kwargs: Any) -> tuple[FakeConn, FakeResp]:
        outbound_calls.append({"target": target_arg, **kwargs})
        return FakeConn(), FakeResp()

    monkeypatch.setattr(outbound, "request", fake_outbound_request)

    with pytest.raises(ExtensionRefusedError, match="coexistence_agent_event_refused"):
        coexistence.forward_outbound(
            bridge_id=bridge.id,
            matrix_event_id="$m_agent",
            sender="@kodera-agent:acme.kodera.io",
            sender_display_name="Kodera Agent",
            text="Automated reply",
        )
    assert outbound_calls == []

    fwd = coexistence.forward_outbound(
        bridge_id=bridge.id,
        matrix_event_id="$m_human_1",
        sender="@alice:acme.kodera.io",
        sender_display_name="Alice",
        text="Hello bridged world",
    )
    assert fwd["delivered"] is True
    assert len(outbound_calls) == 1
    assert outbound_calls[0]["pool"] == "webhook"
    assert outbound_calls[0]["scope_key"] == str(org.id)
    assert outbound_calls[0]["headers"]["X-Kodera-Bridge-Origin"] == str(bridge.id)

    # If external service echoes the exact outbound text back without bot markers, outbound hash guard refuses it!
    echo_back = json.dumps(
        {
            "event_id": "EvEchoBack",
            "team_id": "T01",
            "event": {
                "type": "message",
                "channel": "C01",
                "user": "U9",
                "text": "Hello bridged world",
            },
        }
    ).encode()
    with pytest.raises(
        ExtensionRefusedError, match="coexistence_echo_loop_refused"
    ) as echo_back_err:
        coexistence.receive_webhook(
            bridge_id=bridge.id,
            raw_body=echo_back,
            headers=_sign_coexistence(secret, now_ts, echo_back),
            now_ts=now_ts,
            matrix_transport=synapse,
            room_id="!coex:acme.kodera.io",
        )
    assert echo_back_err.value.status == 409

    # Invariant 4 on inbound attachment: disguised HTML claiming image/png is rejected via IP-pinned fetch + magic-byte check!
    class BadImgResp:
        status = 200

        def read(self, _n: int = 0) -> bytes:
            return b"<html><script>evil()</script></html>"

        def close(self) -> None:
            pass

    monkeypatch.setattr(outbound, "request", lambda _target, **_kwargs: (FakeConn(), BadImgResp()))
    bad_att_payload = json.dumps(
        {
            "event_id": "EvBadAtt",
            "team_id": "T01",
            "event": {
                "type": "message",
                "channel": "C01",
                "user": "U2",
                "text": "See image",
                "attachments": [
                    {
                        "filename": "trick.png",
                        "content_type": "image/png",
                        "url": "https://hooks.example.org/trick.png",
                    }
                ],
            },
        }
    ).encode()
    with pytest.raises(ExtensionRefusedError, match="import_asset_mime_mismatch"):
        coexistence.receive_webhook(
            bridge_id=bridge.id,
            raw_body=bad_att_payload,
            headers=_sign_coexistence(secret, now_ts, bad_att_payload),
            now_ts=now_ts,
            matrix_transport=synapse,
            room_id="!coex:acme.kodera.io",
        )

    # Invariant 3: Delivery-time authority & non-confidential re-check!
    # (`workspaces_channel.is_confidential` is trigger-immutable in SQL; simulate a confidential
    # channel returned at delivery lock time to prove `_lock_and_verify_bridge_authority` refuses 403,
    # and also verify archived channel lifecycle refusal!)
    valid_msg_2 = json.dumps(
        {
            "event_id": "EvConfFlip",
            "team_id": "T01",
            "event": {
                "type": "message",
                "channel": "C01",
                "user": "U2",
                "text": "After confidential check",
            },
        }
    ).encode()
    orig_select_for_update = Channel.objects.select_for_update

    class _ConfChannelQS:
        def filter(self, **_kw: Any) -> _ConfChannelQS:
            return self

        def first(self) -> Channel:
            fake_ch = Channel(
                id=plain_ch.id,
                workspace_id=workspace.id,
                category_id=plain_ch.category_id,
                kind="text",
                name=plain_ch.name,
                position=plain_ch.position,
                lifecycle="active",
                is_confidential=True,
            )
            return fake_ch

    with monkeypatch.context() as mp:
        mp.setattr(Channel.objects, "select_for_update", lambda *a, **k: _ConfChannelQS())
        with pytest.raises(
            ExtensionRefusedError, match="coexistence_confidential_channel_refused"
        ) as flip_err:
            coexistence.receive_webhook(
                bridge_id=bridge.id,
                raw_body=valid_msg_2,
                headers=_sign_coexistence(secret, now_ts, valid_msg_2),
                now_ts=now_ts,
                matrix_transport=synapse,
                room_id="!coex:acme.kodera.io",
            )
        assert flip_err.value.status == 403
    assert Channel.objects.select_for_update == orig_select_for_update

    # Archiving the channel refuses delivery (`403 coexistence_channel_inactive`).
    Channel.objects.filter(id=plain_ch.id).update(lifecycle="archived")
    with pytest.raises(ExtensionRefusedError, match="coexistence_channel_inactive") as arch_err:
        coexistence.receive_webhook(
            bridge_id=bridge.id,
            raw_body=valid_msg_2,
            headers=_sign_coexistence(secret, now_ts, valid_msg_2),
            now_ts=now_ts,
            matrix_transport=synapse,
            room_id="!coex:acme.kodera.io",
        )
    assert arch_err.value.status == 403
    Channel.objects.filter(id=plain_ch.id).update(lifecycle="active")

    # Demoting bridge creator (`members[1]`) from `org_admin` to `org_member` revokes delivery authority immediately!
    Membership.objects.filter(id=members[1].id).update(role="org_member")
    with pytest.raises(
        ExtensionRefusedError, match="coexistence_creator_authority_revoked"
    ) as demote_err:
        coexistence.receive_webhook(
            bridge_id=bridge.id,
            raw_body=valid_msg_2,
            headers=_sign_coexistence(secret, now_ts, valid_msg_2),
            now_ts=now_ts,
            matrix_transport=synapse,
            room_id="!coex:acme.kodera.io",
        )
    assert demote_err.value.status == 403


def test_http_endpoints_attachment_upload_path_writer_role_retention_and_erasure(
    world, native_engine, http_signer, settings, monkeypatch
) -> None:
    org, workspace, members, tokens = world
    plain_ch = _create_channel(workspace, name="http-general", is_confidential=False)

    now = int(time.time())
    configure(settings, [trust_entry(http_signer, org.issuer, expires_at=now + 600)])
    bearer = token(
        http_signer,
        org.issuer,
        subject=tokens[0].subject,
        email_verified=True,
        iat=now,
        nbf=now,
        exp=now + 300,
    )

    monkeypatch.setattr(
        outbound,
        "target",
        lambda url, *, https_only=True: outbound.Target(
            url=url, scheme="https", host="hooks.example.org", port=443, path="/discord"
        ),
    )

    small_zip = archive({"Page.md": "# Imported via HTTP\nClean body"})
    b64_zip = base64.b64encode(small_zip).decode("ascii")

    # Provision least-privilege `kodera_api` writer role and verify `assert_writer_grants`.
    role = f"ext_migrator_writer_{uuid.uuid4().hex[:10]}"
    with connection.cursor() as cursor:
        cursor.execute(
            f'CREATE ROLE "{role}" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
        )
        for stmt in grant_statements(role):
            cursor.execute(stmt)
        assert_writer_grants(cursor, role)

    client = Client()
    secret = "h" * 36

    try:
        with acting_as(role):
            # 1. Inline `< 512 KiB` dry-run preview (takes NO Idempotency-Key and mutates zero rows).
            prev_resp = client.post(
                f"/api/v1/organisations/{org.id}/workspace/imports/preview",
                data=json.dumps({"source": "notion", "inlineArchiveBase64": b64_zip}),
                content_type="application/json",
                HTTP_AUTHORIZATION=f"Bearer {bearer}",
            )
            assert prev_resp.status_code == 200, prev_resp.content
            assert prev_resp.json()["dry_run"] is True
            assert prev_resp.json()["counts"]["docs_pages_total"] == 1
            assert ImportBatch.objects.filter(workspace=workspace).count() == 0

            # Inline archive >= 512 KiB is refused 413 (`import_inline_archive_bound`).
            oversized_inline = base64.b64encode(b"P" * (512 * 1024)).decode("ascii")
            over_resp = client.post(
                f"/api/v1/organisations/{org.id}/workspace/imports/preview",
                data=json.dumps({"source": "notion", "inlineArchiveBase64": oversized_inline}),
                content_type="application/json",
                HTTP_AUTHORIZATION=f"Bearer {bearer}",
            )
            assert over_resp.status_code == 413

            # 2. Coexistence bridge CRUD over HTTP (`POST` -> 201 + replay, `GET` -> 200, inbound event -> 200, `DELETE` -> 204).
            create_key = f"create-bridge-{uuid.uuid4().hex}"
            create_body = json.dumps(
                {
                    "channelId": str(plain_ch.id),
                    "source": "discord",
                    "externalWorkspaceId": "G01GUILD",
                    "externalChannelId": "C01CHAN",
                    "outboundEndpoint": "https://hooks.example.org/discord",
                    "signingSecret": secret,
                }
            )
            c1 = client.post(
                f"/api/v1/organisations/{org.id}/workspace/coexistence/bridges",
                data=create_body,
                content_type="application/json",
                HTTP_IDEMPOTENCY_KEY=create_key,
                HTTP_AUTHORIZATION=f"Bearer {bearer}",
            )
            assert c1.status_code == 201, c1.content
            bridge_id = c1.json()["id"]
            assert c1.json()["active"] is True
            assert "signingSecret" not in c1.json()

            c_replay = client.post(
                f"/api/v1/organisations/{org.id}/workspace/coexistence/bridges",
                data=create_body,
                content_type="application/json",
                HTTP_IDEMPOTENCY_KEY=create_key,
                HTTP_AUTHORIZATION=f"Bearer {bearer}",
            )
            assert c_replay.status_code == 201
            assert c_replay["Idempotency-Replayed"] == "true"

            listed = client.get(
                f"/api/v1/organisations/{org.id}/workspace/coexistence/bridges",
                HTTP_AUTHORIZATION=f"Bearer {bearer}",
            )
            assert listed.status_code == 200
            assert len(listed.json()["bridges"]) == 1

            # Inbound signed Discord event on `/api/v1/coexistence/bridges/<bridge_id>/events`.
            now_ts = int(time.time())
            discord_event = json.dumps(
                {
                    "id": "disc-msg-01",
                    "guild_id": "G01GUILD",
                    "channel_id": "C01CHAN",
                    "content": "Salut depuis Discord",
                    "author": {"id": "99", "username": "Mina"},
                }
            ).encode("utf-8")
            sig_hdrs = _sign_coexistence(secret, now_ts, discord_event)
            ev_resp = client.post(
                f"/api/v1/coexistence/bridges/{bridge_id}/events",
                data=discord_event,
                content_type="application/json",
                HTTP_X_KODERA_COEXISTENCE_TIMESTAMP=sig_hdrs["X-Kodera-Coexistence-Timestamp"],
                HTTP_X_KODERA_COEXISTENCE_SIGNATURE=sig_hdrs["X-Kodera-Coexistence-Signature"],
            )
            assert ev_resp.status_code == 202, ev_resp.content
            assert ev_resp.json()["accepted"] is True
            assert ev_resp.json()["queued"] is True
            assert ev_resp.json()["status"] == "queued"
            assert ev_resp.json()["matrixEventId"] is None

            # Direct SQL DELETE on coexistence bridge or replay guard is refused under `kodera_api`!
            assert refused("DELETE FROM extensions_coexistencebridge") == INSUFFICIENT_PRIVILEGE
            assert (
                refused("DELETE FROM extensions_coexistencereplayguard") == INSUFFICIENT_PRIVILEGE
            )

            del_resp = client.delete(
                f"/api/v1/organisations/{org.id}/workspace/coexistence/bridges/{bridge_id}",
                HTTP_AUTHORIZATION=f"Bearer {bearer}",
            )
            assert del_resp.status_code == 204

        # 3. Uploaded `media_attachment` path for archives up to 20 MiB (verified by SHA-256).
        att_sha = hashlib.sha256(small_zip).hexdigest()
        att = Attachment.objects.create(
            organisation=org,
            uploader=members[0],
            filename="export.zip",
            content_type="application/octet-stream",
            size_bytes=len(small_zip),
            sha256=att_sha,
            upload_expires_at=timezone.now() + timedelta(minutes=15),
            completed_at=timezone.now(),
        )
        from apps.extensions.api import views as ext_views
        from apps.media import services as media_services

        monkeypatch.setattr(
            media_services,
            "get_attachment",
            lambda **_kw: {
                "id": str(att.id),
                "sizeBytes": len(small_zip),
                "sha256": att_sha,
                "downloadUrl": "https://storage.example.org/export.zip",
            },
        )
        monkeypatch.setattr(ext_views, "fetch_attachment_bytes", lambda **_kw: small_zip)

        with acting_as(role):
            exec_resp = client.post(
                f"/api/v1/organisations/{org.id}/workspace/imports/execute",
                data=json.dumps({"source": "notion", "attachmentId": str(att.id)}),
                content_type="application/json",
                HTTP_IDEMPOTENCY_KEY=f"exec-import-{uuid.uuid4().hex}",
                HTTP_AUTHORIZATION=f"Bearer {bearer}",
            )
            assert exec_resp.status_code == 200, exec_resp.content
            assert exec_resp.json()["imported"] == 1

        # 4. 7-day CoexistenceReplayGuard retention purge & trigger protection before expiry.
        guard_row = CoexistenceReplayGuard.objects.get(
            bridge_id=bridge_id, external_event_id="disc-msg-01"
        )
        with pytest.raises(IntegrityError, match="Extension evidence is retained"):
            guard_row.delete()

        CoexistenceReplayGuard.objects.filter(id=guard_row.id).update(
            expires_at=timezone.now() - timedelta(seconds=5),
        )
        purged_count = retention.purge_due()
        assert purged_count >= 1
        assert not CoexistenceReplayGuard.objects.filter(id=guard_row.id).exists()

        # 5. Full workspace erasure teardown (`extension_erasure_step`) zeroes active bridge secrets & removes bridge + replay rows.
        active_bridge = CoexistenceBridge.objects.create(
            workspace=workspace,
            channel=plain_ch,
            creator=members[0],
            source="slack",
            external_workspace_id="T99",
            external_channel_id="C99",
            outbound_endpoint="https://hooks.example.org/erasure",
            sealed_signing_secret=b"x" * 48,
        )
        CoexistenceReplayGuard.objects.create(
            bridge=active_bridge,
            external_event_id="ev-erasure",
            event_sha256="a" * 64,
            direction="inbound",
        )
        from test_core_erasure import begin
        from test_extension_retention_worker import now as db_now

        cutoff = db_now()
        expected_bridge_urns = retention.receiver_inventory(organisation_id=org.id)
        assert any(
            urn.startswith(f"urn:kodera:coexistence-bridge:{active_bridge.id}:endpoint-sha256:")
            for urn in expected_bridge_urns
        )
        erasure = begin(org, not_before=cutoff)
        assert erasure.inventory["extension_receivers"] == list(expected_bridge_urns)
        for domain in erasure.inventory["required_domains"]:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT public.privacy_record_absence(%s,%s,%s,%s,%s,%s)",
                    [
                        erasure.id,
                        domain,
                        erasure.cutoff_at,
                        "b" * 64,
                        "ABS-" + domain[:12],
                        db_now(),
                    ],
                )
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT public.extension_erasure_step(%s,%s,%s,%s,100)",
                [erasure.id, org.id, erasure.cutoff_at, erasure.inventory_sha256],
            )
            row_val = cursor.fetchone()
            assert row_val is not None
            step_out = json.loads(row_val[0]) if isinstance(row_val[0], str) else row_val[0]
        assert step_out["payloads_complete"] is True
        assert step_out["metadata_complete"] is True
        assert retention.local_payloads_absent(organisation_id=org.id) is True
        assert retention.metadata_absent(organisation_id=org.id) is True
        assert WorkspaceCutoff.objects.filter(organisation_id=org.id).exists()
    finally:
        with connection.cursor() as cursor:
            cursor.execute("RESET ROLE")
            cursor.execute(f'DROP OWNED BY "{role}"')
            cursor.execute(f'DROP ROLE "{role}"')


def test_http_channel_map_confidential_refusal_and_operator_worker_drain(
    world, http_signer, settings, monkeypatch
) -> None:
    """HTTP `executeWorkspaceImport` with `channelMap` refuses confidential targets (`403`),
    queues non-confidential Matrix history (`queued_matrix`) without creating Documents,
    hooks `services.enqueue(event_type='message.created')` for outbound coexistence, and
    drains all three queues via `dispatch_extension_coexistence --once`."""
    from django.core.management import call_command

    from apps.extensions import services as ext_services
    from apps.orgs.management import operator as operator_mod

    org, workspace, members, tokens = world
    plain_ch = _create_channel(workspace, name="plain-import-room", is_confidential=False)
    conf_ch = _create_channel(workspace, name="conf-import-room", is_confidential=True)

    now = int(time.time())
    configure(settings, [trust_entry(http_signer, org.issuer, expires_at=now + 600)])
    bearer = token(
        http_signer,
        org.issuer,
        subject=tokens[0].subject,
        email_verified=True,
        iat=now,
        nbf=now,
        exp=now + 300,
    )

    monkeypatch.setattr(
        outbound,
        "target",
        lambda url, *, https_only=True: outbound.Target(
            url=url, scheme="https", host="hooks.example.org", port=443, path="/slack-out"
        ),
    )

    slack_zip = archive(
        {
            "channels.json": json.dumps([{"id": "C77", "name": "eng"}]),
            "users.json": json.dumps([{"id": "U1", "name": "alice"}]),
            "eng/2026-01-01.json": json.dumps(
                [
                    {"ts": "1700000001.000100", "user": "U1", "text": "Root history msg"},
                    {
                        "ts": "1700000002.000200",
                        "thread_ts": "1700000001.000100",
                        "user": "U1",
                        "text": "Thread reply msg",
                    },
                ]
            ),
        }
    )
    b64_slack = base64.b64encode(slack_zip).decode("ascii")

    client = Client()
    # 1. Confidential target channel in `channelMap` MUST fail 403 over HTTP (`matrix_transport=None`)!
    conf_resp = client.post(
        f"/api/v1/organisations/{org.id}/workspace/imports/execute",
        data=json.dumps(
            {
                "source": "slack",
                "inlineArchiveBase64": b64_slack,
                "channelMap": {"C77": str(conf_ch.id)},
            }
        ),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=f"conf-map-{uuid.uuid4().hex}",
        HTTP_AUTHORIZATION=f"Bearer {bearer}",
    )
    assert conf_resp.status_code == 403, conf_resp.content
    assert Document.objects.filter(workspace=workspace).count() == 0
    assert ImportedObject.objects.filter(workspace=workspace).count() == 0

    # 2. Non-confidential `channelMap` queues `queued_matrix` rows (zero native Documents created!).
    ok_resp = client.post(
        f"/api/v1/organisations/{org.id}/workspace/imports/execute",
        data=json.dumps(
            {
                "source": "slack",
                "inlineArchiveBase64": b64_slack,
                "channelMap": {"C77": str(plain_ch.id)},
            }
        ),
        content_type="application/json",
        HTTP_IDEMPOTENCY_KEY=f"plain-map-{uuid.uuid4().hex}",
        HTTP_AUTHORIZATION=f"Bearer {bearer}",
    )
    assert ok_resp.status_code == 200, ok_resp.content
    body = ok_resp.json()
    assert body["queued_messages"] == 2
    assert body["replayed_messages"] == 0
    assert body["complete"] is False
    assert Document.objects.filter(workspace=workspace).count() == 0
    assert (
        ImportedObject.objects.filter(workspace=workspace, replay_state="queued_matrix").count()
        == 2
    )

    # 3. Inbound HTTP coexistence event (`202` queued) + outbound `services.enqueue('message.created')` hook!
    secret = "w" * 36
    bridge = coexistence.create_bridge(
        verified=tokens[0],
        organisation_id=org.id,
        channel_id=plain_ch.id,
        source="slack",
        external_workspace_id="T77",
        external_channel_id="C77",
        outbound_endpoint="https://hooks.example.org/slack-out",
        signing_secret=secret,
    )
    inbound_raw = json.dumps(
        {
            "event_id": "EvQueuedIn01",
            "team_id": "T77",
            "event": {"type": "message", "channel": "C77", "user": "U9", "text": "Queued inbound"},
        }
    ).encode()
    sig_hdrs = _sign_coexistence(secret, now, inbound_raw)
    in_resp = client.post(
        f"/api/v1/coexistence/bridges/{bridge.id}/events",
        data=inbound_raw,
        content_type="application/json",
        HTTP_X_KODERA_COEXISTENCE_TIMESTAMP=sig_hdrs["X-Kodera-Coexistence-Timestamp"],
        HTTP_X_KODERA_COEXISTENCE_SIGNATURE=sig_hdrs["X-Kodera-Coexistence-Signature"],
    )
    assert in_resp.status_code == 202
    assert (
        CoexistenceReplayGuard.objects.get(bridge=bridge, external_event_id="EvQueuedIn01").state
        == "queued"
    )

    inst = ext_services.install(
        verified=tokens[0],
        organisation_id=org.id,
        name="MsgHook",
        endpoint="https://hooks.example.org/ext",
        events=["message.created"],
    )
    ext_services.enqueue(
        verified=tokens[0],
        organisation_id=org.id,
        installation_id=inst.id,
        event_key="msg-hook-01",
        event_type="message.created",
        data={
            "channel_id": str(plain_ch.id),
            "matrix_event_id": "$local_msg_01",
            "sender": "@alice:acme.kodera.io",
            "sender_display_name": "Alice",
            "text": "Local room message via extension event",
        },
    )
    assert (
        CoexistenceReplayGuard.objects.get(
            bridge=bridge, external_event_id="out:local_msg_01"
        ).state
        == "queued"
    )

    # 4. Operator worker command `dispatch_extension_coexistence --once` drains all 3 queues!
    matrix_sent: list[dict[str, Any]] = []

    class FakeWorkerSynapse:
        def resolve_channel_room(self, channel_id: uuid.UUID) -> str:
            return f"!room-{channel_id}:acme.kodera.io"

        def send_message(self, *, room_id: str, txn_id: str, content: dict[str, Any]) -> str:
            matrix_sent.append({"room_id": room_id, "txn_id": txn_id, "content": content})
            return f"$evt-{len(matrix_sent)}"

    webhook_posts: list[dict[str, Any]] = []

    class OkConn:
        def close(self) -> None:
            pass

    class OkResp:
        status = 200

        def read(self, _n: int = 0) -> bytes:
            return b"ok"

        def close(self) -> None:
            pass

    def record_webhook(target_arg: Any, **kw: Any) -> tuple[OkConn, OkResp]:
        webhook_posts.append({"target": target_arg, **kw})
        return OkConn(), OkResp()

    monkeypatch.setattr(outbound, "request", record_webhook)
    from apps.extensions.management.commands import dispatch_extension_coexistence as cmd_mod

    monkeypatch.setattr(cmd_mod, "require_operator_profile", lambda: None)
    settings.KODERA_MATRIX_REPLAY_TRANSPORT_FACTORY = FakeWorkerSynapse
    out_buf = io.StringIO()
    call_command(
        "dispatch_extension_coexistence",
        "--once",
        "--organisation",
        str(org.id),
        stdout=out_buf,
    )
    summary = json.loads(out_buf.getvalue())
    assert summary["imports"]["replayed"] == 2
    assert summary["inbound"]["delivered"] == 1
    assert summary["outbound"]["delivered"] == 1
    assert len(matrix_sent) == 3
    assert matrix_sent[1]["content"]["m.relates_to"] == {
        "rel_type": "m.thread",
        "event_id": "$evt-1",
    }
    assert len(webhook_posts) == 1
    assert ImportedObject.objects.filter(workspace=workspace, replay_state="replayed").count() == 2
    assert ImportBatch.objects.get(workspace=workspace, source="slack").state == "complete"
    assert (
        CoexistenceReplayGuard.objects.get(bridge=bridge, external_event_id="EvQueuedIn01").state
        == "delivered"
    )
    assert (
        CoexistenceReplayGuard.objects.get(
            bridge=bridge, external_event_id="out:local_msg_01"
        ).state
        == "delivered"
    )
    assert operator_mod.require_operator_profile is not None


def test_authority_revocation_during_attachment_fetch_and_compensating_redact(
    world, monkeypatch
) -> None:
    """Revoking creator authority during external attachment fetch aborts BEFORE Matrix PUT;
    revoking creator authority during Matrix PUT issues immediate compensating Matrix redaction."""
    org, workspace, members, tokens = world
    plain_ch = _create_channel(workspace, name="fence-room", is_confidential=False)
    Membership.objects.filter(id=members[1].id).update(role="org_admin")

    monkeypatch.setattr(
        outbound,
        "target",
        lambda url, *, https_only=True: outbound.Target(
            url=url, scheme="https", host="cdn.example.org", port=443, path="/asset.png"
        ),
    )
    secret = "f" * 36
    bridge = coexistence.create_bridge(
        verified=tokens[1],
        organisation_id=org.id,
        channel_id=plain_ch.id,
        source="slack",
        external_workspace_id="TFENCE",
        external_channel_id="CFENCE",
        outbound_endpoint="https://cdn.example.org/hook",
        signing_secret=secret,
    )

    valid_png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32

    class PngConn:
        def close(self) -> None:
            pass

    class PngResp:
        status = 200

        def read(self, _n: int = 0) -> bytes:
            return valid_png

        def close(self) -> None:
            pass

    def revoke_during_attachment_fetch(_target: Any, **_kw: Any) -> tuple[PngConn, PngResp]:
        Membership.objects.filter(id=members[1].id).update(role="org_member")
        return PngConn(), PngResp()

    monkeypatch.setattr(outbound, "request", revoke_during_attachment_fetch)

    sent_events: list[str] = []
    redacted_events: list[tuple[str, str, str]] = []

    class FenceSynapse:
        def send_message(self, *, room_id: str, txn_id: str, content: dict[str, Any]) -> str:
            ev_id = f"$sent-{len(sent_events) + 1}"
            sent_events.append(ev_id)
            return ev_id

        def redact_message(
            self, *, room_id: str, event_id: str, txn_id: str, reason: str = ""
        ) -> str:
            redacted_events.append((room_id, event_id, reason))
            return "$redact-1"

    synapse = FenceSynapse()
    now_ts = int(time.time())
    att_payload = json.dumps(
        {
            "event_id": "EvRevokeDuringFetch",
            "team_id": "TFENCE",
            "event": {
                "type": "message",
                "channel": "CFENCE",
                "user": "U2",
                "text": "With remote attachment",
                "attachments": [
                    {
                        "filename": "photo.png",
                        "content_type": "image/png",
                        "url": "https://cdn.example.org/asset.png",
                    }
                ],
            },
        }
    ).encode()

    with pytest.raises(
        ExtensionRefusedError, match="coexistence_creator_authority_revoked"
    ) as err1:
        coexistence.receive_webhook(
            bridge_id=bridge.id,
            raw_body=att_payload,
            headers=_sign_coexistence(secret, now_ts, att_payload),
            now_ts=now_ts,
            matrix_transport=synapse,
            room_id="!fence:acme.kodera.io",
        )
    assert err1.value.status == 403
    assert sent_events == []  # ZERO Matrix events emitted!

    # Restore `org_admin`, then revoke DURING `send_message` to verify compensating `redact_message`!
    Membership.objects.filter(id=members[1].id).update(role="org_admin")

    class RevokingDuringSendSynapse:
        def send_message(self, *, room_id: str, txn_id: str, content: dict[str, Any]) -> str:
            sent_events.append("$midflight-1")
            Membership.objects.filter(id=members[1].id).update(role="org_member")
            return "$midflight-1"

        def redact_message(
            self, *, room_id: str, event_id: str, txn_id: str, reason: str = ""
        ) -> str:
            redacted_events.append((room_id, event_id, reason))
            return "$redact-midflight"

    mid_payload = json.dumps(
        {
            "event_id": "EvRevokeMidSend",
            "team_id": "TFENCE",
            "event": {"type": "message", "channel": "CFENCE", "user": "U2", "text": "Mid-flight"},
        }
    ).encode()
    with pytest.raises(
        ExtensionRefusedError, match="coexistence_creator_authority_revoked"
    ) as err2:
        coexistence.receive_webhook(
            bridge_id=bridge.id,
            raw_body=mid_payload,
            headers=_sign_coexistence(secret, now_ts, mid_payload),
            now_ts=now_ts,
            matrix_transport=RevokingDuringSendSynapse(),
            room_id="!fence:acme.kodera.io",
        )
    assert err2.value.status == 403
    assert redacted_events == [
        ("!fence:acme.kodera.io", "$midflight-1", "coexistence_authority_revoked")
    ]


def test_retryable_network_failures_and_prelock_hmac_protection(world, monkeypatch) -> None:
    """Failed outbound/inbound network attempts (`502`/`503`) transition to `retryable_failed`
    and succeed cleanly on attempt 2 (never permanent `409`), while invalid HMACs never contend
    on organisation advisory locks."""
    org, workspace, _, tokens = world
    plain_ch = _create_channel(workspace, name="retry-room", is_confidential=False)
    monkeypatch.setattr(
        outbound,
        "target",
        lambda url, *, https_only=True: outbound.Target(
            url=url, scheme="https", host="hooks.example.org", port=443, path="/retry"
        ),
    )
    secret = "r" * 36
    bridge = coexistence.create_bridge(
        verified=tokens[0],
        organisation_id=org.id,
        channel_id=plain_ch.id,
        source="slack",
        external_workspace_id="TRETRY",
        external_channel_id="CRETRY",
        outbound_endpoint="https://hooks.example.org/retry",
        signing_secret=secret,
    )

    # 1. Invalid HMAC is rejected BEFORE `lock_erasure_cutoff_fences` is ever invoked!
    from apps.orgs.selectors import lock_erasure_cutoff_fences as orig_lock

    lock_calls = 0

    def counting_lock(**kw: Any) -> None:
        nonlocal lock_calls
        lock_calls += 1
        orig_lock(**kw)

    monkeypatch.setattr(coexistence, "lock_erasure_cutoff_fences", counting_lock)
    now_ts = int(time.time())
    bad_body = b'{"event_id":"EvBadSig","team_id":"TRETRY","event":{"channel":"CRETRY","text":"x"}}'
    with pytest.raises(ExtensionRefusedError, match="coexistence_signature_invalid"):
        coexistence.receive_webhook(
            bridge_id=bridge.id,
            raw_body=bad_body,
            headers={
                "X-Kodera-Coexistence-Timestamp": str(now_ts),
                "X-Kodera-Coexistence-Signature": "v1=" + "0" * 64,
            },
            now_ts=now_ts,
        )
    assert lock_calls == 0

    # 2. Outbound 502 on attempt 1 -> `retryable_failed` -> 200 `delivered` on attempt 2!
    attempt_counter = 0

    class Conn:
        def close(self) -> None:
            pass

    class Resp:
        def __init__(self, code: int) -> None:
            self.status = code

        def read(self, _n: int = 0) -> bytes:
            return b""

        def close(self) -> None:
            pass

    def flaky_outbound(_target: Any, **_kw: Any) -> tuple[Conn, Resp]:
        nonlocal attempt_counter
        attempt_counter += 1
        return Conn(), Resp(502 if attempt_counter == 1 else 200)

    monkeypatch.setattr(outbound, "request", flaky_outbound)

    with pytest.raises(ExtensionRefusedError, match="coexistence_outbound_refused") as out_err:
        coexistence.forward_outbound(
            bridge_id=bridge.id,
            matrix_event_id="$flaky_out_1",
            sender="@alice:acme.kodera.io",
            sender_display_name="Alice",
            text="Retry me",
        )
    assert out_err.value.status == 502
    assert (
        CoexistenceReplayGuard.objects.get(bridge=bridge, external_event_id="out:flaky_out_1").state
        == "retryable_failed"
    )

    second = coexistence.forward_outbound(
        bridge_id=bridge.id,
        matrix_event_id="$flaky_out_1",
        sender="@alice:acme.kodera.io",
        sender_display_name="Alice",
        text="Retry me",
    )
    assert second["delivered"] is True
    assert attempt_counter == 2
    assert (
        CoexistenceReplayGuard.objects.get(bridge=bridge, external_event_id="out:flaky_out_1").state
        == "delivered"
    )

    # 3. Inbound Matrix 503 on attempt 1 -> `retryable_failed` -> `delivered` on attempt 2!
    in_attempts = 0

    class FlakySynapse:
        def send_message(self, *, room_id: str, txn_id: str, content: dict[str, Any]) -> str:
            nonlocal in_attempts
            in_attempts += 1
            if in_attempts == 1:
                raise ExtensionRefusedError("import_matrix_unavailable", 503)
            return "$in-ok-2"

    in_body = json.dumps(
        {
            "event_id": "EvFlakyIn",
            "team_id": "TRETRY",
            "event": {
                "type": "message",
                "channel": "CRETRY",
                "user": "U3",
                "text": "Retry inbound",
            },
        }
    ).encode()
    in_hdrs = _sign_coexistence(secret, now_ts, in_body)
    with pytest.raises(ExtensionRefusedError, match="import_matrix_unavailable"):
        coexistence.receive_webhook(
            bridge_id=bridge.id,
            raw_body=in_body,
            headers=in_hdrs,
            now_ts=now_ts,
            matrix_transport=FlakySynapse(),
            room_id="!retry:acme.kodera.io",
        )
    assert (
        CoexistenceReplayGuard.objects.get(bridge=bridge, external_event_id="EvFlakyIn").state
        == "retryable_failed"
    )
    in_ok = coexistence.receive_webhook(
        bridge_id=bridge.id,
        raw_body=in_body,
        headers=in_hdrs,
        now_ts=now_ts,
        matrix_transport=FlakySynapse(),
        room_id="!retry:acme.kodera.io",
    )
    assert in_ok["status"] == "delivered"
    assert in_ok["matrixEventId"] == "$in-ok-2"


def test_discord_zip_and_raw_json_import_parity(world) -> None:
    """`import_parsers.parse('discord', ...)` and `imports.preview` support both raw `.json`
    exports and `.zip` multi-channel Discord archives with magic-byte asset checks."""
    org, workspace, _, tokens = world
    ch_doc_1 = {
        "channel": {"id": "9001", "name": "announcements", "topic": "News"},
        "members": [
            {"id": "42", "name": "GuildOwner", "permissions": "8", "email": "owner@ex.org"}
        ],
        "messages": [
            {
                "id": "100",
                "timestamp": "2026-02-01T10:00:00Z",
                "author": {"id": "42", "name": "GuildOwner"},
                "content": "Welcome from Discord",
            },
            {
                "id": "101",
                "timestamp": "2026-02-01T10:01:00Z",
                "author": {"id": "42", "name": "GuildOwner"},
                "content": "Thread follow-up",
                "reference": {"messageId": "100"},
            },
        ],
    }
    ch_doc_2 = {
        "channel": {"id": "9002", "name": "support"},
        "messages": [
            {
                "id": "200",
                "timestamp": "2026-02-01T11:00:00Z",
                "author": {"id": "77", "name": "Helper"},
                "content": "How can we help?",
            }
        ],
    }

    raw_json = json.dumps(ch_doc_1).encode("utf-8")
    parsed_raw = import_parsers.parse("discord", raw_json)
    assert len(parsed_raw.channels) == 1
    assert len(parsed_raw.messages) == 2
    assert parsed_raw.messages[1].thread_parent_key == "discord:message:9001:100"
    assert parsed_raw.external_users[0].had_external_admin_privilege is True

    valid_png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24
    zip_discord = archive(
        {
            "channels/announcements.json": json.dumps(ch_doc_1),
            "channels/support.json": json.dumps(ch_doc_2),
            "assets/banner.png": valid_png,
        }
    )
    parsed_zip = import_parsers.parse("discord", zip_discord)
    assert [c.external_id for c in parsed_zip.channels] == ["9001", "9002"]
    assert len(parsed_zip.messages) == 3
    assert parsed_zip.omitted_assets == 1

    dry_report = imports.preview(
        verified=tokens[0],
        organisation_id=org.id,
        source="discord",
        raw=zip_discord,
    )
    assert dry_report["dry_run"] is True
    assert dry_report["counts"]["channels_total"] == 2
    assert dry_report["counts"]["messages_total"] == 3
    assert dry_report["counts"]["thread_replies_total"] == 1
    assert "external_admin_privilege_ignored" in dry_report["warnings"]
    assert ImportBatch.objects.filter(workspace=workspace).count() == 0


def test_outbound_dns_preresolution_revocation_fence_and_body_read_error_recovery(
    world, monkeypatch
) -> None:
    """Revoking creator authority during DNS resolution (`outbound.addresses`) aborts with 403
    BEFORE any TCP socket or HTTP request bytes are transmitted; socket `OSError` during
    response-body `read()` transitions the lease cleanly to `retryable_failed`."""
    import socket

    org, workspace, members, tokens = world
    plain_ch = _create_channel(workspace, name="dns-fence-room", is_confidential=False)
    Membership.objects.filter(id=members[1].id).update(role="org_admin")

    monkeypatch.setattr(
        outbound,
        "target",
        lambda url, *, https_only=True: outbound.Target(
            url=url, scheme="https", host="hooks.example.org", port=443, path="/dns-fence"
        ),
    )
    bridge = coexistence.create_bridge(
        verified=tokens[1],
        organisation_id=org.id,
        channel_id=plain_ch.id,
        source="slack",
        external_workspace_id="TDNS",
        external_channel_id="CDNS",
        outbound_endpoint="https://hooks.example.org/dns-fence",
        signing_secret="d" * 36,
    )

    # 1. Revocation during DNS resolution (`outbound.addresses`) aborts BEFORE `PinnedConnection`!
    transmitted_connections: list[Any] = []

    def revoking_dns_addresses(
        destination: Any,
        deadline: float,
        *,
        pool: str = "default",
        scope_key: str | None = None,
    ) -> list[tuple[Any, ...]]:
        assert pool == "webhook"
        assert scope_key == str(org.id)
        Membership.objects.filter(id=members[1].id).update(role="org_member")
        return [
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("93.184.216.34", 443))
        ]

    class ForbiddenPinnedConnection:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            transmitted_connections.append(args)
            raise AssertionError("PinnedConnection must never be instantiated after DNS revocation")

    monkeypatch.setattr(outbound, "addresses", revoking_dns_addresses)
    monkeypatch.setattr(outbound, "PinnedConnection", ForbiddenPinnedConnection)

    with pytest.raises(
        ExtensionRefusedError, match="coexistence_creator_authority_revoked"
    ) as dns_err:
        coexistence.forward_outbound(
            bridge_id=bridge.id,
            matrix_event_id="$dns_revoked_1",
            sender="@alice:acme.kodera.io",
            sender_display_name="Alice",
            text="Must never transmit",
        )
    assert dns_err.value.status == 403
    assert transmitted_connections == []
    assert not CoexistenceReplayGuard.objects.filter(
        bridge=bridge, external_event_id="out:dns_revoked_1"
    ).exists()

    # 2. Restore `org_admin` and simulate `OSError` during `resp.read()` -> `retryable_failed`!
    Membership.objects.filter(id=members[1].id).update(role="org_admin")
    monkeypatch.setattr(
        outbound,
        "addresses",
        lambda *_a, **_kw: [
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("93.184.216.34", 443))
        ],
    )

    read_calls = 0

    class BrokenReadResp:
        status = 200

        def read(self, _n: int = 0) -> bytes:
            nonlocal read_calls
            read_calls += 1
            if read_calls == 1:
                raise OSError("socket reset mid-body")
            return b"ok"

        def close(self) -> None:
            pass

    class FakePinnedConn:
        transmitted = True

        def __init__(self, *_a: Any, **_kw: Any) -> None:
            pass

        def request(self, *_a: Any, **_kw: Any) -> None:
            pass

        def getresponse(self) -> BrokenReadResp:
            return BrokenReadResp()

        def close(self) -> None:
            pass

    monkeypatch.setattr(outbound, "PinnedConnection", FakePinnedConn)

    with pytest.raises(ExtensionRefusedError, match="coexistence_outbound_unavailable") as read_err:
        coexistence.forward_outbound(
            bridge_id=bridge.id,
            matrix_event_id="$body_read_err_1",
            sender="@alice:acme.kodera.io",
            sender_display_name="Alice",
            text="Body read reset",
        )
    assert read_err.value.status == 502
    failed_guard = CoexistenceReplayGuard.objects.get(
        bridge=bridge, external_event_id="out:body_read_err_1"
    )
    assert failed_guard.state == "retryable_failed"
    assert failed_guard.lease_id is None
    assert failed_guard.lease_expires_at is None

    recovered = coexistence.forward_outbound(
        bridge_id=bridge.id,
        matrix_event_id="$body_read_err_1",
        sender="@alice:acme.kodera.io",
        sender_display_name="Alice",
        text="Body read reset",
    )
    assert recovered["delivered"] is True
    assert CoexistenceReplayGuard.objects.get(id=failed_guard.id).state == "delivered"


def test_drain_recovers_expired_in_flight_inbound_and_outbound_leases(world, monkeypatch) -> None:
    """`drain_coexistence_inbound` and `drain_coexistence_outbound` automatically select and
    recover expired `in_flight` leases (`lease_expires_at <= now`) left by a crashed worker."""
    import socket

    org, workspace, _, tokens = world
    plain_ch = _create_channel(workspace, name="lease-recovery-room", is_confidential=False)
    monkeypatch.setattr(
        outbound,
        "target",
        lambda url, *, https_only=True: outbound.Target(
            url=url, scheme="https", host="hooks.example.org", port=443, path="/recover"
        ),
    )
    monkeypatch.setattr(
        outbound,
        "addresses",
        lambda *_a, **_kw: [
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("93.184.216.34", 443))
        ],
    )

    class OkResp:
        status = 200

        def read(self, _n: int = 0) -> bytes:
            return b"ok"

        def close(self) -> None:
            pass

    class OkPinnedConn:
        transmitted = True

        def __init__(self, *_a: Any, **_kw: Any) -> None:
            pass

        def request(self, *_a: Any, **_kw: Any) -> None:
            pass

        def getresponse(self) -> OkResp:
            return OkResp()

        def close(self) -> None:
            pass

    monkeypatch.setattr(outbound, "PinnedConnection", OkPinnedConn)

    bridge = coexistence.create_bridge(
        verified=tokens[0],
        organisation_id=org.id,
        channel_id=plain_ch.id,
        source="slack",
        external_workspace_id="TLEASE",
        external_channel_id="CLEASE",
        outbound_endpoint="https://hooks.example.org/recover",
        signing_secret="l" * 36,
    )

    expired_at = timezone.now() - timedelta(seconds=10)
    in_guard = CoexistenceReplayGuard.objects.create(
        bridge=bridge,
        external_event_id="EvExpiredIn",
        event_sha256="1" * 64,
        direction="inbound",
        state="in_flight",
        lease_id=uuid.uuid4(),
        lease_expires_at=expired_at,
        attempts=1,
        matrix_txn_id="kodera-coex-" + "1" * 32,
        sanitized_payload={"body": "Imported author: A (Slack U1)\n\nRecovered inbound"},
    )
    out_guard = CoexistenceReplayGuard.objects.create(
        bridge=bridge,
        external_event_id="out:expired_out_1",
        event_sha256=coexistence.content_echo_sha256(bridge.id, "Recovered outbound"),
        direction="outbound",
        state="in_flight",
        lease_id=uuid.uuid4(),
        lease_expires_at=expired_at,
        attempts=1,
        matrix_event_id="$expired_out_1",
        sanitized_payload={
            "sender": "@alice:acme.kodera.io",
            "sender_display_name": "Alice",
            "text": "Recovered outbound",
            "matrix_event_id": "$expired_out_1",
        },
    )

    class RecoverySynapse:
        def resolve_channel_room(self, channel_id: uuid.UUID) -> str:
            return f"!rec-{channel_id}:acme.kodera.io"

        def send_message(self, *, room_id: str, txn_id: str, content: dict[str, Any]) -> str:
            return "$recovered-matrix-ev"

    in_summary = coexistence.drain_coexistence_inbound(
        matrix_transport=RecoverySynapse(),
        organisation_id=org.id,
    )
    out_summary = coexistence.drain_coexistence_outbound(organisation_id=org.id)

    assert in_summary == {"delivered": 1, "retryable": 0, "obsoleted": 0}
    assert out_summary == {"delivered": 1, "retryable": 0, "obsoleted": 0}

    in_guard.refresh_from_db()
    out_guard.refresh_from_db()
    assert in_guard.state == "delivered"
    assert in_guard.lease_id is None
    assert in_guard.matrix_event_id == "$recovered-matrix-ev"
    assert in_guard.sanitized_payload is None
    assert out_guard.state == "delivered"
    assert out_guard.lease_id is None
    assert out_guard.sanitized_payload is None
