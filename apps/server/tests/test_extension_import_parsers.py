"""Golden exported channel/page inputs and archive/active-content refusal vectors."""

import binascii
import io
import json
import struct
import zipfile

import pytest

from apps.extensions.import_parsers import parse
from apps.extensions.wire import ExtensionRefusedError


def archive(entries, compression=zipfile.ZIP_DEFLATED):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=compression) as document:
        for name, content in entries.items():
            document.writestr(name, content)
    return output.getvalue()


def test_slack_export_preserves_channel_structure_authors_and_message_ids():
    raw = archive(
        {
            "channels.json": json.dumps([{"id": "C1", "name": "general"}]),
            "users.json": json.dumps(
                [{"id": "U1", "name": "member", "profile": {"display_name": "Synthetic Author"}}]
            ),
            "general/2026-11-13.json": json.dumps(
                [
                    {
                        "ts": "1794560000.000001",
                        "user": "U1",
                        "text": "Hello <script>bad()</script> <!channel>",
                    }
                ]
            ),
        }
    )
    result = parse("slack", raw)
    assert [item.external_key for item in result.items] == [
        "slack:channel:C1",
        "slack:message:C1:1794560000.000001",
    ]
    message = result.items[1]
    assert message.parent_key == result.items[0].external_key
    assert "Synthetic Author" in message.markdown and "U1" in message.markdown
    assert "<script>" not in message.markdown and "bad()" not in message.markdown


def test_discord_channel_json_preserves_external_author_without_impersonation():
    raw = json.dumps(
        {
            "channel": {"id": "123", "name": "team"},
            "messages": [
                {
                    "id": "456",
                    "timestamp": "2026-11-13T12:00:00+00:00",
                    "content": "A synthetic message",
                    "author": {"id": "789", "name": "Synthetic Discord Author"},
                    "attachments": [{"url": "https://private.invalid/attachment.svg"}],
                }
            ],
        }
    ).encode()
    result = parse("discord", raw)
    assert result.items[1].external_key == "discord:message:123:456"
    assert "Synthetic Discord Author" in result.items[1].markdown
    assert result.omitted_assets == 1
    assert "private.invalid" not in result.items[1].markdown


def test_notion_markdown_csv_become_hierarchy_and_typed_collection_rows():
    raw = archive(
        {
            "Studio.md": "# Studio\nSynthetic workspace",
            "Studio/Plan.md": "# Plan\nText <img src='https://blocked.invalid/x.svg'>",
            "Studio/Tasks.csv": "Title,Estimate,Done,Due\nBuild,2,true,2026-11-13\nReview,3,false,2026-11-14\n",
            "Studio/logo.svg": "<svg><script>bad()</script></svg>",
        }
    )
    result = parse("notion", raw)
    by_key = {item.external_key: item for item in result.items}
    tasks = by_key["notion:page:Studio/Tasks.csv"]
    assert tasks.parent_key == "notion:page:Studio.md"
    assert [prop["type"] for prop in tasks.properties] == ["text", "number", "checkbox", "date"]
    assert by_key["notion:row:Studio/Tasks.csv:1"].values == {
        "c0": "Build",
        "c1": 2,
        "c2": True,
        "c3": "2026-11-13",
    }
    assert "<img" not in by_key["notion:page:Studio/Plan.md"].markdown
    assert result.omitted_assets == 1
    assert parse("notion", raw) == result


@pytest.mark.parametrize(
    "name", ["../escape.md", "/absolute.md", "a/../../escape.md", "a\\evil.md"]
)
def test_archive_traversal_and_backslash_names_refuse(name):
    with pytest.raises(ExtensionRefusedError, match="archive_path"):
        parse("notion", archive({name: "unsafe"}))


def test_zip_symlinks_and_duplicate_normalized_paths_refuse():
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as document:
        info = zipfile.ZipInfo("link.md")
        info.create_system = 3
        info.external_attr = 0o120777 << 16
        document.writestr(info, "target")
    with pytest.raises(ExtensionRefusedError, match="archive_symlink"):
        parse("notion", output.getvalue())
    with pytest.raises(ExtensionRefusedError, match="archive_duplicate"):
        parse("notion", archive({"A.md": "one", "a.md": "two"}))


def test_compression_bomb_is_refused_before_content_expansion():
    with pytest.raises(ExtensionRefusedError, match="archive_bound"):
        parse("notion", archive({"bomb.md": "x" * 1_000_000}))


def test_notion_directories_without_parent_markdown_get_native_folder_plan():
    result = parse("notion", archive({"Studio/Sub/Notes.md": "# Notes\nSynthetic"}))
    assert [item.external_key for item in result.items] == [
        "notion:folder:Studio",
        "notion:folder:Studio/Sub",
        "notion:page:Studio/Sub/Notes.md",
    ]
    assert result.items[1].parent_key == result.items[0].external_key
    assert result.items[2].parent_key == result.items[1].external_key


def test_reference_images_links_and_encoded_html_stay_inert_without_fetching():
    result = parse(
        "notion",
        archive(
            {
                "Page.md": "![image][asset]\n[asset]: https://private.invalid/a.svg\n[open](javascript:alert(1))\n&lt;img src=x onerror=bad()&gt;"
            }
        ),
    )
    text = result.items[0].markdown
    assert "![" not in text and "[asset]" not in text and "<img" not in text


@pytest.mark.parametrize(
    "compression",
    [
        pytest.param(zipfile.ZIP_STORED, id="stored"),
        pytest.param(zipfile.ZIP_DEFLATED, id="deflated"),
    ],
)
def test_standard_bounded_zip_codecs_remain_supported(compression):
    result = parse("notion", archive({"Page.md": "# Synthetic page\nBounded content"}, compression))
    assert result.items[0].markdown == "# Synthetic page\nBounded content"


@pytest.mark.parametrize(
    "compression",
    [pytest.param(zipfile.ZIP_BZIP2, id="bzip2"), pytest.param(zipfile.ZIP_LZMA, id="lzma")],
)
def test_forged_metadata_unbounded_zip_codecs_refuse_before_any_member_opens(
    compression, monkeypatch
):
    raw = bytearray(archive({"Page.md": b"X" * (4 * 1024 * 1024)}, compression))
    central = raw.index(b"PK\x01\x02")
    # Forged sizes/CRC used to pass advertised bounds while codec internals expanded 4MiB.
    crc = binascii.crc32(b"X")
    for offset, value in [(14, crc), (22, 1), (central + 16, crc), (central + 24, 1)]:
        struct.pack_into("<I", raw, offset, value)
    with zipfile.ZipFile(io.BytesIO(raw)) as check:
        assert check.infolist()[0].file_size == 1
        assert check.infolist()[0].compress_type == compression

    def opened(*args, **kwargs):
        pytest.fail("unsupported ZIP member opened before compression refusal")

    monkeypatch.setattr(zipfile.ZipFile, "open", opened)
    with pytest.raises(ExtensionRefusedError, match="archive_compression"):
        parse("notion", bytes(raw))


def many_user_slack_archive():
    return archive(
        {
            "channels.json": json.dumps([{"id": "C1", "name": "general"}]),
            "users.json": json.dumps(
                [{"id": f"U{i:05d}", "name": f"member-{i:05d}"} for i in range(10_000)]
            ),
            "general/2026-11-01.json": json.dumps(
                [{"ts": "1794560000.000001", "user": "U09999", "text": "Last user attribution"}]
            ),
        }
    )


def test_large_slack_member_report_is_bounded_without_truncating_attribution():
    from pathlib import Path
    from uuid import UUID

    import jsonschema_rs
    import yaml

    from apps.extensions.imports import MAX_RESPONSE_MEMBER_MAPPINGS, response_member_mappings
    from apps.extensions.member_matching import match_external_users
    from core.idempotency.store import StoredResponse

    raw = many_user_slack_archive()
    assert len(raw) < 128 * 1024
    parsed = parse("slack", raw)
    assert len(parsed.external_users) == 10_000
    # No emails: matching performs no DB access, so this regression stays non-socket.
    matched = match_external_users(
        organisation_id=UUID(int=1), external_users=parsed.external_users
    )
    warnings = []
    report = {"member_mappings": response_member_mappings(matched, warnings), "warnings": warnings}
    assert len(report["member_mappings"]) == MAX_RESPONSE_MEMBER_MAPPINGS
    encoded = json.dumps(report).encode()
    assert len(encoded) < 128 * 1024
    assert StoredResponse(status=200, body=encoded, content_type="application/json").body == encoded
    contract = yaml.safe_load(
        (
            Path(__file__).resolve().parents[3] / "packages/api-contract/core-api.openapi.yaml"
        ).read_text()
    )
    report_properties = contract["components"]["schemas"]["WorkspaceImportDryRunReport"][
        "properties"
    ]
    jsonschema_rs.validate(
        {
            "type": "object",
            "additionalProperties": False,
            "properties": {key: report_properties[key] for key in report},
            "components": contract["components"],
        },
        report,
    )
    assert warnings == ["unsupported_assets_omitted"]
    assert matched.by_external_id["U09999"].display_name == "member-09999"
    assert len(matched.mappings) == matched.unmatched_count == 10_000
    assert report["member_mappings"][0]["external_id"] == "U00000"
    assert report["member_mappings"][-1]["external_id"] == "U00249"
