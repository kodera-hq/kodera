"""Offline export normalization; bounded archives and inert author-attributed content."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import re
import stat
import unicodedata
import zipfile
from dataclasses import asdict, dataclass
from datetime import date, datetime
from html.parser import HTMLParser
from pathlib import PurePosixPath
from typing import Any, BinaryIO

from .wire import ExtensionRefusedError, canonical

MAX_ARCHIVE, MAX_EXPANDED, MAX_FILE, MAX_ITEMS = (
    20 * 1024 * 1024,
    40 * 1024 * 1024,
    2 * 1024 * 1024,
    500,
)
CHUNK_SIZE = 65536
ID = re.compile(r"[A-Za-z0-9_.-]{1,128}\Z")
EMAIL_SHAPE = re.compile(r"^[^\s@<>\"']{1,128}@[^\s@<>\"']{1,190}\Z")
NOTION_HASH_SUFFIX = re.compile(r"^(?P<title>.+)\s+[0-9a-fA-F]{32}\Z")
DISCORD_ADMIN_BIT = 0x8

DISGUISED_MARKUP_MARKERS = (
    b"<script",
    b"<svg",
    b"<!doctype html",
    b"<html",
    b"<?xml",
    b"<iframe",
    b"<object",
)

BINARY_ASSET_EXTENSIONS: dict[str, tuple[str, ...]] = {
    ".pdf": ("application/pdf",),
    ".png": ("image/png",),
    ".jpg": ("image/jpeg",),
    ".jpeg": ("image/jpeg",),
    ".gif": ("image/gif",),
    ".webp": ("image/webp",),
    ".ogg": ("audio/ogg", "video/ogg", "application/ogg"),
    ".oga": ("audio/ogg", "application/ogg"),
    ".webm": ("video/webm", "audio/webm"),
}

FORBIDDEN_ACTIVE_EXTENSIONS = frozenset(
    {
        ".html",
        ".htm",
        ".xhtml",
        ".svg",
        ".svgz",
        ".xml",
        ".xsl",
        ".js",
        ".mjs",
        ".cjs",
        ".vbs",
        ".swf",
        ".jar",
        ".exe",
        ".sh",
        ".bat",
        ".cmd",
        ".ps1",
    }
)


@dataclass(frozen=True)
class Item:
    external_key: str
    title: str
    markdown: str
    parent_key: str | None = None
    properties: tuple[dict[str, Any], ...] = ()
    values: dict[str, Any] | None = None
    collection_key: str | None = None

    @property
    def sha256(self) -> str:
        return hashlib.sha256(canonical(asdict(self))).hexdigest()


@dataclass(frozen=True)
class ImportedChannel:
    external_id: str
    external_key: str
    name: str
    topic: str = ""


@dataclass(frozen=True)
class ImportedMessage:
    external_key: str
    channel_external_id: str
    channel_key: str
    message_id: str
    author_external_id: str
    author_display_name: str
    timestamp: str
    text: str
    thread_parent_key: str | None = None

    @property
    def sha256(self) -> str:
        return hashlib.sha256(canonical(asdict(self))).hexdigest()


@dataclass(frozen=True)
class ImportedExternalUser:
    external_id: str
    display_name: str
    email: str | None = None
    is_bot: bool = False
    had_external_admin_privilege: bool = False


@dataclass(frozen=True)
class Parsed:
    items: tuple[Item, ...]
    omitted_assets: int = 0
    channels: tuple[ImportedChannel, ...] = ()
    messages: tuple[ImportedMessage, ...] = ()
    external_users: tuple[ImportedExternalUser, ...] = ()


class PlainHTML(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.skip = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "iframe", "object", "svg", "math"}:
            self.skip += 1
        elif tag in {"br", "p", "div"} and not self.skip:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "iframe", "object", "svg", "math"}:
            self.skip = max(0, self.skip - 1)

    def handle_data(self, data: str) -> None:
        if not self.skip:
            self.parts.append(data)


def _replace_markdown_constructs(value: str, *, images: bool) -> str:
    """Linear O(N) replacement of `![alt](url)` or `[label](url)` without regex backtracking."""
    marker = "![" if images else "["
    marker_len = len(marker)
    length = len(value)
    if marker not in value:
        return value
    out: list[str] = []
    emit_from = 0
    search_from = 0
    # Each delimiter cursor is `-2` before first lookup, `-1` once exhausted, or a monotonically
    # non-decreasing index in `value`, bounding total character scans across all cursors to <= 4*N.
    close_bracket = -2
    next_paren = -2
    next_newline = -2

    while search_from < length:
        start = value.find(marker, search_from)
        if start == -1:
            break
        label_start = start + marker_len
        if close_bracket != -1 and close_bracket < label_start:
            close_bracket = value.find("]", label_start)
        if close_bracket == -1:
            break
        if close_bracket + 1 >= length or value[close_bracket + 1] != "(":
            # Every opener in [start, close_bracket) shares this exact first `]`, so none can match.
            search_from = close_bracket + 1
            continue
        url_start = close_bracket + 2
        if next_paren != -1 and next_paren < url_start:
            next_paren = value.find(")", url_start)
        if next_newline != -1 and next_newline < url_start:
            next_newline = value.find("\n", url_start)
        if next_paren == -1:
            break
        if next_newline != -1 and next_newline < next_paren:
            # A newline precedes any closing `)`, so this `](` cannot close; skip past `](`.
            search_from = url_start
            continue
        out.append(value[emit_from:start])
        out.append("[image omitted]" if images else value[label_start:close_bracket])
        emit_from = next_paren + 1
        search_from = emit_from

    if not out:
        return value
    out.append(value[emit_from:])
    return "".join(out)


def clean(value: Any, maximum: int = 60000) -> str:
    if (
        not isinstance(value, str)
        or len(value) > maximum
        or any(0xD800 <= ord(c) <= 0xDFFF for c in value)
    ):
        raise ExtensionRefusedError("import_text_bound")
    value = _replace_markdown_constructs(value, images=True)
    value = _replace_markdown_constructs(value, images=False)
    parser = PlainHTML()
    parser.feed(value)
    parser.close()
    text = unicodedata.normalize("NFC", "".join(parser.parts))
    text = "".join(c for c in text if c in "\n\t" or ord(c) >= 32 and ord(c) != 127)
    return (
        text.replace("@", "＠")
        .replace("[", "［")
        .replace("]", "］")
        .replace("<", "＜")
        .replace(">", "＞")
        .strip()
    )


def _convert_aside_callouts(value: str) -> str:
    """Linear O(N) rewrite of Notion `<aside>...</aside>` blocks into Markdown `> ` callouts."""
    lower = value.lower()
    if "<aside" not in lower:
        return value
    out: list[str] = []
    pos = 0
    length = len(value)
    while pos < length:
        open_idx = lower.find("<aside", pos)
        if open_idx == -1:
            out.append(value[pos:])
            break
        tag_end = lower.find(">", open_idx + 6)
        if tag_end == -1:
            out.append(value[pos:])
            break
        close_idx = lower.find("</aside>", tag_end + 1)
        if close_idx == -1:
            out.append(value[pos:])
            break
        out.append(value[pos:open_idx])
        inner = value[tag_end + 1 : close_idx].strip()
        if inner:
            callout_lines = [
                f"> {line.strip()}" if line.strip() else ">" for line in inner.splitlines()
            ]
            out.append("\n" + "\n".join(callout_lines) + "\n")
        pos = close_idx + 8
    return "".join(out)


def clean_notion_markdown(value: Any, maximum: int = 60000) -> str:
    """Preserve headings, fenced code blocks, and `> ` callouts while neutralizing active HTML/SVG/links."""
    if (
        not isinstance(value, str)
        or len(value) > maximum
        or any(0xD800 <= ord(c) <= 0xDFFF for c in value)
    ):
        raise ExtensionRefusedError("import_text_bound")
    prepared = _convert_aside_callouts(value)
    lines = prepared.splitlines()
    out_lines: list[str] = []
    in_fence = False
    fence_lines: list[str] = []
    fence_lang = ""

    for raw_line in lines:
        stripped = raw_line.lstrip(" ")
        if stripped.startswith("```"):
            if not in_fence:
                in_fence = True
                raw_lang = stripped[3:].strip()
                fence_lang = "".join(
                    ch for ch in raw_lang if ch.isalnum() or ch in {"_", "+", "-"}
                )[:32]
                fence_lines = []
            else:
                in_fence = False
                cleaned_code = clean("\n".join(fence_lines), maximum) if fence_lines else ""
                out_lines.append("```" + fence_lang)
                if cleaned_code:
                    out_lines.append(cleaned_code)
                out_lines.append("```")
                fence_lines = []
                fence_lang = ""
            continue

        if in_fence:
            fence_lines.append(raw_line)
            continue

        if stripped.startswith(">"):
            body = stripped[1:].lstrip(" ")
            cleaned_body = clean(body, maximum) if body else ""
            out_lines.append(f"> {cleaned_body}" if cleaned_body else ">")
        else:
            if not raw_line.strip():
                out_lines.append("")
            else:
                # Preserve leading ATX heading prefix (`# `..`###### `) cleanly.
                hashes = len(stripped) - len(stripped.lstrip("#"))
                if 1 <= hashes <= 6 and stripped[hashes : hashes + 1] == " ":
                    heading_body = clean(stripped[hashes + 1 :], maximum)
                    out_lines.append(("#" * hashes + " " + heading_body).rstrip())
                else:
                    out_lines.append(clean(raw_line, maximum))

    if in_fence:
        cleaned_code = clean("\n".join(fence_lines), maximum) if fence_lines else ""
        out_lines.append("```" + fence_lang)
        if cleaned_code:
            out_lines.append(cleaned_code)
        out_lines.append("```")

    return "\n".join(out_lines).strip()


def detect_magic_mime(raw: bytes) -> str | None:
    """Inspect magic-byte headers for admitted non-active binary media formats."""
    if not isinstance(raw, (bytes, bytearray)) or len(raw) < 4:
        return None
    head = bytes(raw[:1024])
    lower_head = head.lower()
    if any(marker in lower_head for marker in DISGUISED_MARKUP_MARKERS):
        return None
    if head.startswith(b"%PDF-"):
        return "application/pdf"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head.startswith(b"OggS"):
        return "audio/ogg"
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        return "video/webm"
    return None


def verify_asset_magic(filename: str, raw: bytes, declared_mime: str | None = None) -> str:
    """Validate extension, magic-byte header, and absence of disguised HTML/SVG/XML/script."""
    if not isinstance(filename, str) or not filename.strip() or not isinstance(raw, bytes):
        raise ExtensionRefusedError("import_asset_mime_refused")
    if not raw or len(raw) > MAX_FILE:
        raise ExtensionRefusedError("import_asset_bound", 413)
    ext = PurePosixPath(filename.strip()).suffix.lower()
    if ext in FORBIDDEN_ACTIVE_EXTENSIONS:
        raise ExtensionRefusedError("import_asset_active_content_refused")
    allowed_mimes = BINARY_ASSET_EXTENSIONS.get(ext)
    if allowed_mimes is None:
        raise ExtensionRefusedError("import_asset_mime_refused")
    head_lower = raw[:1024].lstrip().lower()
    if any(marker in head_lower for marker in DISGUISED_MARKUP_MARKERS):
        raise ExtensionRefusedError("import_asset_mime_mismatch")
    detected = detect_magic_mime(raw)
    if detected is None or detected not in allowed_mimes:
        raise ExtensionRefusedError("import_asset_mime_mismatch")
    if declared_mime is not None:
        normalized_mime = declared_mime.split(";", 1)[0].strip().lower()
        if normalized_mime not in allowed_mimes:
            raise ExtensionRefusedError("import_asset_mime_mismatch")
        return normalized_mime
    return detected


def _validate_archive_embedded_assets(files: dict[str, bytes]) -> None:
    """Reject archive files claiming a binary media extension whose magic bytes do not match."""
    for path, content in files.items():
        ext = PurePosixPath(path).suffix.lower()
        if ext in BINARY_ASSET_EXTENSIONS:
            verify_asset_magic(path, content)


def identifier(value: Any) -> str:
    if not isinstance(value, str) or ID.fullmatch(value) is None:
        raise ExtensionRefusedError("import_external_id_invalid")
    return value


def _normalize_email(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    if (
        not normalized
        or len(normalized) > 320
        or any(ord(c) <= 32 or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF for c in normalized)
        or EMAIL_SHAPE.fullmatch(normalized) is None
    ):
        return None
    return normalized


def text_file(raw: bytes) -> str:
    try:
        return raw.decode("utf-8-sig")
    except UnicodeError:
        raise ExtensionRefusedError("import_utf8_required") from None


def _prepare_archive_stream(source: bytes | BinaryIO) -> BinaryIO:
    if isinstance(source, bytes):
        if not source or len(source) > MAX_ARCHIVE:
            raise ExtensionRefusedError("import_archive_bound", 413)
        return io.BytesIO(source)
    if not hasattr(source, "read"):
        raise ExtensionRefusedError("import_archive_bound", 413)
    if callable(getattr(source, "seekable", None)) and source.seekable():
        start = source.tell()
        source.seek(0, io.SEEK_END)
        end = source.tell()
        size = end - start
        source.seek(start)
        if not 0 < size <= MAX_ARCHIVE:
            raise ExtensionRefusedError("import_archive_bound", 413)
        return source
    bounded = io.BytesIO()
    total = 0
    while True:
        chunk = source.read(CHUNK_SIZE)
        if not isinstance(chunk, bytes):
            raise ExtensionRefusedError("import_archive_invalid")
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_ARCHIVE:
            raise ExtensionRefusedError("import_archive_bound", 413)
        bounded.write(chunk)
    if total == 0:
        raise ExtensionRefusedError("import_archive_bound", 413)
    bounded.seek(0)
    return bounded


def archive(source: bytes | BinaryIO) -> dict[str, bytes]:
    stream_source = _prepare_archive_stream(source)
    try:
        with zipfile.ZipFile(stream_source) as zf:
            files: dict[str, bytes] = {}
            seen: set[str] = set()
            advertised_total = 0
            expanded_total = 0
            entries = zf.infolist()
            if len(entries) > 1000:
                raise ExtensionRefusedError("import_archive_bound", 413)
            # Other codecs can allocate an unbounded expansion/dictionary before ZipExtFile
            # slices to the advertised size. Preflight every entry before opening any member.
            if any(
                info.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
                for info in entries
            ):
                raise ExtensionRefusedError("import_archive_compression")
            ordered_by_offset = sorted(entries, key=lambda item: item.header_offset)
            for idx, info in enumerate(ordered_by_offset):
                if info.header_offset < 0 or info.compress_size < 0 or info.file_size < 0:
                    raise ExtensionRefusedError("import_archive_bound", 413)
                if idx + 1 < len(ordered_by_offset):
                    nxt = ordered_by_offset[idx + 1]
                    if info.header_offset + 30 + info.compress_size > nxt.header_offset:
                        raise ExtensionRefusedError("import_archive_bound", 413)
            for info in entries:
                name = unicodedata.normalize("NFC", info.filename)
                if (
                    name.startswith("/")
                    or info.orig_filename != info.filename
                    or "" in name.rstrip("/").split("/")
                    or any(unicodedata.category(char) in {"Cc", "Cf"} for char in name)
                    or "\\" in name
                    or "\x00" in name
                    or any(part in {"..", "."} for part in name.split("/"))
                    or ":" in name
                    or len(name) > 500
                ):
                    raise ExtensionRefusedError("import_archive_path")
                if stat.S_ISLNK(info.external_attr >> 16):
                    raise ExtensionRefusedError("import_archive_symlink")
                if info.flag_bits & 1:
                    raise ExtensionRefusedError("import_archive_encrypted")
                if info.is_dir():
                    continue
                key = name.casefold()
                if not name or key in seen:
                    raise ExtensionRefusedError("import_archive_duplicate")
                seen.add(key)
                advertised_total += info.file_size
                max_ratio_bytes = max(1, info.compress_size) * 100
                if (
                    info.file_size > MAX_FILE
                    or advertised_total > MAX_EXPANDED
                    or info.file_size > max_ratio_bytes
                    or (
                        info.compress_type == zipfile.ZIP_STORED
                        and info.file_size != info.compress_size
                    )
                ):
                    raise ExtensionRefusedError("import_archive_bound", 413)
                with zf.open(info) as member_stream:
                    if info.compress_type == zipfile.ZIP_DEFLATED and hasattr(
                        member_stream, "_left"
                    ):
                        # Never let a forged central-directory `file_size` prematurely stop
                        # reading a larger deflate stream or mask a compression bomb.
                        member_stream._left = MAX_FILE + 1
                    chunks: list[bytes] = []
                    entry_bytes = 0
                    while True:
                        chunk = member_stream.read(CHUNK_SIZE)
                        if not chunk:
                            break
                        entry_bytes += len(chunk)
                        expanded_total += len(chunk)
                        if (
                            entry_bytes > MAX_FILE
                            or expanded_total > MAX_EXPANDED
                            or entry_bytes > max_ratio_bytes
                        ):
                            raise ExtensionRefusedError("import_archive_bound", 413)
                        chunks.append(chunk)
                    decompressor = getattr(member_stream, "_decompressor", None)
                    if (
                        entry_bytes != info.file_size
                        or getattr(member_stream, "_compress_left", 0) != 0
                        or (
                            decompressor is not None
                            and (not decompressor.eof or bool(decompressor.unconsumed_tail))
                        )
                    ):
                        raise ExtensionRefusedError("import_archive_bound", 413)
                files[name] = b"".join(chunks)
            return files
    except ExtensionRefusedError:
        raise
    except (OSError, ValueError, RuntimeError, zipfile.BadZipFile):
        raise ExtensionRefusedError("import_archive_invalid") from None


def document(raw: bytes) -> Any:
    try:
        if len(raw) > MAX_FILE:
            raise ValueError
        return json.loads(
            text_file(raw), parse_constant=lambda _: (_ for _ in ()).throw(ValueError())
        )
    except (ValueError, TypeError, RecursionError):
        raise ExtensionRefusedError("import_json_invalid") from None


def _discord_has_admin_privilege(entry: dict[str, Any]) -> bool:
    if bool(entry.get("isAdmin") or entry.get("is_admin") or entry.get("is_owner")):
        return True
    raw_perms = entry.get("permissions")
    if isinstance(raw_perms, int) and not isinstance(raw_perms, bool):
        if raw_perms & DISCORD_ADMIN_BIT:
            return True
    elif isinstance(raw_perms, str) and raw_perms.isascii() and raw_perms.isdigit():
        if len(raw_perms) <= 30 and (int(raw_perms) & DISCORD_ADMIN_BIT):
            return True
    roles = entry.get("roles")
    if isinstance(roles, list):
        for role in roles[:100]:
            if isinstance(role, dict) and _discord_has_admin_privilege(role):
                return True
    return False


def slack(source: bytes | BinaryIO) -> Parsed:
    files = archive(source)
    _validate_archive_embedded_assets(files)
    channels, users = (
        document(files.get("channels.json", b"[]")),
        document(files.get("users.json", b"[]")),
    )
    if (
        not isinstance(channels, list)
        or not channels
        or len(channels) > 100
        or not isinstance(users, list)
        or len(users) > 10000
    ):
        raise ExtensionRefusedError("import_slack_manifest")
    authors: dict[str, str] = {}
    external_users: list[ImportedExternalUser] = []
    seen_users: set[str] = set()
    for row in users:
        if not isinstance(row, dict):
            raise ExtensionRefusedError("import_slack_manifest")
        uid = identifier(row["id"])
        if uid in seen_users:
            raise ExtensionRefusedError("import_duplicate_object")
        seen_users.add(uid)
        raw_profile = row.get("profile")
        profile: dict[str, Any] = raw_profile if isinstance(raw_profile, dict) else {}
        display_name = clean(
            profile.get("display_name") or row.get("real_name") or row.get("name") or uid,
            200,
        )
        authors[uid] = display_name
        is_bot = bool(row.get("is_bot") or row.get("is_app_user") or uid == "USLACKBOT")
        had_admin = bool(row.get("is_owner") or row.get("is_primary_owner") or row.get("is_admin"))
        email = None if is_bot else _normalize_email(profile.get("email") or row.get("email"))
        external_users.append(
            ImportedExternalUser(
                external_id=uid,
                display_name=display_name,
                email=email,
                is_bot=is_bot,
                had_external_admin_privilege=had_admin,
            )
        )
    items: list[Item] = []
    parsed_channels: list[ImportedChannel] = []
    parsed_messages: list[ImportedMessage] = []
    omitted = 0
    for channel in channels:
        channel_id, name = identifier(channel["id"]), clean(channel["name"], 200)
        folder = channel["name"]
        if not name or "/" in folder or "\\" in folder:
            raise ExtensionRefusedError("import_slack_channel")
        topic_raw = ""
        if isinstance(channel.get("topic"), dict) and isinstance(
            channel["topic"].get("value"), str
        ):
            topic_raw = clean(channel["topic"]["value"], 500)
        elif isinstance(channel.get("topic"), str):
            topic_raw = clean(channel["topic"], 500)
        parent = "slack:channel:" + channel_id
        parsed_channels.append(ImportedChannel(channel_id, parent, name, topic_raw))
        items.append(Item(parent, name, "Imported Slack channel " + channel_id))
        for path in sorted(files):
            if not path.startswith(folder + "/") or not path.endswith(".json"):
                continue
            messages = document(files[path])
            if not isinstance(messages, list):
                raise ExtensionRefusedError("import_slack_messages")
            for message in messages:
                stamp = identifier(message["ts"])
                author = identifier(message.get("user") or message.get("bot_id") or "unknown")
                author_name = authors.get(author, author)
                omitted += len(message.get("files", [])) + len(message.get("attachments", []))
                cleaned_text = clean(message.get("text", ""))
                thread_parent_key: str | None = None
                raw_thread_ts = message.get("thread_ts")
                if raw_thread_ts is not None:
                    thread_ts = identifier(raw_thread_ts)
                    if thread_ts != stamp:
                        thread_parent_key = f"slack:message:{channel_id}:{thread_ts}"
                msg_key = f"slack:message:{channel_id}:{stamp}"
                content = (
                    f"Imported author: {author_name} (Slack {author})\nSource timestamp: {stamp}\n\n"
                    + cleaned_text
                )
                items.append(Item(msg_key, "Message " + stamp, content, parent))
                parsed_messages.append(
                    ImportedMessage(
                        external_key=msg_key,
                        channel_external_id=channel_id,
                        channel_key=parent,
                        message_id=stamp,
                        author_external_id=author,
                        author_display_name=author_name,
                        timestamp=stamp,
                        text=cleaned_text,
                        thread_parent_key=thread_parent_key,
                    )
                )
                if len(items) > MAX_ITEMS:
                    raise ExtensionRefusedError("import_item_bound", 413)
    return Parsed(
        tuple(items),
        omitted,
        channels=tuple(parsed_channels),
        messages=tuple(parsed_messages),
        external_users=tuple(external_users),
    )


def _parse_discord_channel_doc(
    value: Any,
    *,
    items: list[Item],
    parsed_channels: list[ImportedChannel],
    parsed_messages: list[ImportedMessage],
    users_by_id: dict[str, ImportedExternalUser],
    seen_channel_ids: set[str],
) -> int:
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("channel"), dict)
        or not isinstance(value.get("messages"), list)
    ):
        raise ExtensionRefusedError("import_discord_schema")
    channel_id = identifier(value["channel"]["id"])
    if channel_id in seen_channel_ids:
        raise ExtensionRefusedError("import_discord_schema")
    seen_channel_ids.add(channel_id)
    channel_name = clean(value["channel"]["name"], 200)
    channel_topic = (
        clean(value["channel"]["topic"], 500)
        if isinstance(value["channel"].get("topic"), str)
        else ""
    )
    parent = "discord:channel:" + channel_id
    parsed_channels.append(ImportedChannel(channel_id, parent, channel_name, channel_topic))
    items.append(Item(parent, channel_name, "Imported Discord channel " + channel_id))
    if len(items) > MAX_ITEMS:
        raise ExtensionRefusedError("import_item_bound", 413)

    raw_members = value.get("members") or value.get("users")
    if raw_members is not None:
        if not isinstance(raw_members, list) or len(raw_members) > 10000:
            raise ExtensionRefusedError("import_discord_schema")
        for member in raw_members:
            if not isinstance(member, dict):
                raise ExtensionRefusedError("import_discord_schema")
            uid = identifier(member["id"])
            uname = clean(member.get("nickname") or member.get("name") or uid, 200)
            is_bot = bool(member.get("isBot") or member.get("bot"))
            had_admin = _discord_has_admin_privilege(member)
            email = None if is_bot else _normalize_email(member.get("email"))
            existing_member = users_by_id.get(uid)
            if existing_member is None:
                users_by_id[uid] = ImportedExternalUser(
                    external_id=uid,
                    display_name=uname,
                    email=email,
                    is_bot=is_bot,
                    had_external_admin_privilege=had_admin,
                )
            else:
                users_by_id[uid] = ImportedExternalUser(
                    external_id=existing_member.external_id,
                    display_name=existing_member.display_name,
                    email=existing_member.email or email,
                    is_bot=existing_member.is_bot or is_bot,
                    had_external_admin_privilege=(
                        existing_member.had_external_admin_privilege or had_admin
                    ),
                )

    omitted = 0
    for message in value["messages"]:
        if not isinstance(message, dict):
            raise ExtensionRefusedError("import_discord_schema")
        message_id = identifier(message["id"])
        author = message.get("author", {})
        if not isinstance(author, dict):
            raise ExtensionRefusedError("import_discord_schema")
        author_id = identifier(author["id"])
        name = clean(author.get("nickname") or author.get("name") or author_id, 200)
        is_bot = bool(author.get("isBot") or author.get("bot"))
        had_admin = _discord_has_admin_privilege(author)
        author_email = None if is_bot else _normalize_email(author.get("email"))
        existing = users_by_id.get(author_id)
        if existing is None:
            users_by_id[author_id] = ImportedExternalUser(
                external_id=author_id,
                display_name=name,
                email=author_email,
                is_bot=is_bot,
                had_external_admin_privilege=had_admin,
            )
        elif had_admin and not existing.had_external_admin_privilege:
            users_by_id[author_id] = ImportedExternalUser(
                external_id=existing.external_id,
                display_name=existing.display_name,
                email=existing.email or author_email,
                is_bot=existing.is_bot or is_bot,
                had_external_admin_privilege=True,
            )

        stamp = message.get("timestamp")
        if (
            not isinstance(stamp, str)
            or datetime.fromisoformat(stamp.replace("Z", "+00:00")).tzinfo is None
        ):
            raise ExtensionRefusedError("import_discord_timestamp")
        omitted += len(message.get("attachments", [])) + len(message.get("embeds", []))
        cleaned_text = clean(message.get("content", ""))
        thread_parent_key: str | None = None
        ref = message.get("reference")
        if isinstance(ref, dict) and ref.get("messageId") is not None:
            ref_id = identifier(ref["messageId"])
            if ref_id != message_id:
                thread_parent_key = f"discord:message:{channel_id}:{ref_id}"
        msg_key = f"discord:message:{channel_id}:{message_id}"
        content = (
            f"Imported author: {name} (Discord {author_id})\nSource timestamp: {stamp}\n\n"
            + cleaned_text
        )
        items.append(Item(msg_key, "Message " + message_id, content, parent))
        parsed_messages.append(
            ImportedMessage(
                external_key=msg_key,
                channel_external_id=channel_id,
                channel_key=parent,
                message_id=message_id,
                author_external_id=author_id,
                author_display_name=name,
                timestamp=stamp,
                text=cleaned_text,
                thread_parent_key=thread_parent_key,
            )
        )
        if len(items) > MAX_ITEMS:
            raise ExtensionRefusedError("import_item_bound", 413)
    return omitted


def discord(source: bytes | BinaryIO) -> Parsed:
    items: list[Item] = []
    parsed_channels: list[ImportedChannel] = []
    parsed_messages: list[ImportedMessage] = []
    users_by_id: dict[str, ImportedExternalUser] = {}
    seen_channel_ids: set[str] = set()

    if isinstance(source, bytes):
        is_zip = len(source) >= 4 and source[:4] in {b"PK\x03\x04", b"PK\x05\x06"}
        if is_zip:
            files = archive(source)
            _validate_archive_embedded_assets(files)
            json_paths = [p for p in sorted(files) if p.lower().endswith(".json")]
            if not json_paths:
                raise ExtensionRefusedError("import_discord_schema")
            omitted = sum(1 for p in files if not p.lower().endswith(".json"))
            for path in json_paths:
                omitted += _parse_discord_channel_doc(
                    document(files[path]),
                    items=items,
                    parsed_channels=parsed_channels,
                    parsed_messages=parsed_messages,
                    users_by_id=users_by_id,
                    seen_channel_ids=seen_channel_ids,
                )
            return Parsed(
                tuple(items),
                omitted,
                channels=tuple(parsed_channels),
                messages=tuple(parsed_messages),
                external_users=tuple(users_by_id.values()),
            )
        raw = source
    else:
        stream = _prepare_archive_stream(source)
        head = stream.read(4)
        stream.seek(0)
        if len(head) >= 4 and head in {b"PK\x03\x04", b"PK\x05\x06"}:
            files = archive(stream)
            _validate_archive_embedded_assets(files)
            json_paths = [p for p in sorted(files) if p.lower().endswith(".json")]
            if not json_paths:
                raise ExtensionRefusedError("import_discord_schema")
            omitted = sum(1 for p in files if not p.lower().endswith(".json"))
            for path in json_paths:
                omitted += _parse_discord_channel_doc(
                    document(files[path]),
                    items=items,
                    parsed_channels=parsed_channels,
                    parsed_messages=parsed_messages,
                    users_by_id=users_by_id,
                    seen_channel_ids=seen_channel_ids,
                )
            return Parsed(
                tuple(items),
                omitted,
                channels=tuple(parsed_channels),
                messages=tuple(parsed_messages),
                external_users=tuple(users_by_id.values()),
            )
        raw = stream.read(MAX_FILE + 1)
        if len(raw) > MAX_FILE:
            raise ExtensionRefusedError("import_archive_bound", 413)

    omitted = _parse_discord_channel_doc(
        document(raw),
        items=items,
        parsed_channels=parsed_channels,
        parsed_messages=parsed_messages,
        users_by_id=users_by_id,
        seen_channel_ids=seen_channel_ids,
    )
    return Parsed(
        tuple(items),
        omitted,
        channels=tuple(parsed_channels),
        messages=tuple(parsed_messages),
        external_users=tuple(users_by_id.values()),
    )


def column(values: list[str], *, allow_select: bool = False) -> tuple[str, list[dict[str, str]]]:
    filled = [value for value in values if value]
    if (
        filled
        and len(filled) == len(values)
        and all(value.lower() in {"true", "false"} for value in filled)
    ):
        return "checkbox", []
    if filled and all(
        re.fullmatch(r"-?(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?", value)
        and math.isfinite(float(value))
        for value in filled
    ):
        return "number", []
    if filled:
        try:
            if all(date.fromisoformat(value).isoformat() == value for value in filled):
                return "date", []
        except ValueError:
            pass
    if allow_select and len(filled) >= 2:
        unique_labels = list(dict.fromkeys(filled))
        if (
            1 <= len(unique_labels) < len(filled)
            and len(unique_labels) <= 20
            and all(len(label) <= 64 and "\n" not in label for label in unique_labels)
        ):
            options = [
                {"id": f"opt_{idx}", "label": label} for idx, label in enumerate(unique_labels)
            ]
            return "select", options
    return "text", []


def _notion_title(stem: str) -> str:
    match = NOTION_HASH_SUFFIX.fullmatch(stem)
    candidate = match.group("title") if match is not None else stem
    return clean(candidate, 200)


def notion(source: bytes | BinaryIO) -> Parsed:
    files = archive(source)
    _validate_archive_embedded_assets(files)
    paths = sorted(path for path in files if path.lower().endswith((".md", ".csv")))
    markdown_pages = {path[:-3].casefold(): path for path in paths if path.lower().endswith(".md")}

    def directory_key(directory: str) -> str | None:
        if directory == ".":
            return None
        match = markdown_pages.get(directory.casefold())
        return "notion:page:" + match if match is not None else "notion:folder:" + directory

    directories = {
        str(parent)
        for path in paths
        for parent in PurePosixPath(path).parents
        if str(parent) != "."
    }
    items: list[Item] = [
        Item(
            "notion:folder:" + directory,
            _notion_title(PurePosixPath(directory).name),
            "Imported Notion folder",
            directory_key(str(PurePosixPath(directory).parent)),
        )
        for directory in sorted(directories)
        if directory.casefold() not in markdown_pages
    ]
    for path in sorted(paths, key=lambda value: (len(PurePosixPath(value).parts), value)):
        location = PurePosixPath(path)
        parent = directory_key(str(location.parent))
        key = "notion:page:" + path
        title = _notion_title(location.stem)
        if path.lower().endswith(".md"):
            items.append(Item(key, title, clean_notion_markdown(text_file(files[path])), parent))
        else:
            try:
                rows = list(csv.reader(io.StringIO(text_file(files[path])), strict=True))
            except csv.Error:
                raise ExtensionRefusedError("import_csv_invalid") from None
            if (
                not rows
                or not 1 <= len(rows[0]) <= 50
                or len(rows) > 201
                or any(len(row) != len(rows[0]) for row in rows)
                or len(set(rows[0])) != len(rows[0])
            ):
                raise ExtensionRefusedError("import_csv_bound")
            headers = [clean(value, 100) for value in rows[0]]
            if any(not value for value in headers):
                raise ExtensionRefusedError("import_csv_header")
            data = [[" ".join(clean(cell, 10000).split()) for cell in row] for row in rows[1:]]
            inferred = [
                column([row[index] for row in data], allow_select=index > 0)
                for index in range(len(headers))
            ]
            properties_list: list[dict[str, Any]] = []
            select_label_to_id: dict[int, dict[str, str]] = {}
            for index, name in enumerate(headers):
                kind, options = inferred[index]
                prop: dict[str, Any] = {"id": "c" + str(index), "name": name, "type": kind}
                if kind == "select":
                    prop["options"] = options
                    select_label_to_id[index] = {opt["label"]: opt["id"] for opt in options}
                properties_list.append(prop)
            properties = tuple(properties_list)
            items.append(Item(key, title, "Imported Notion CSV table", parent, properties))
            for index, row in enumerate(data, 1):
                values: dict[str, Any] = {}
                for number, cell in enumerate(row):
                    kind, _ = inferred[number]
                    values["c" + str(number)] = (
                        None
                        if not cell
                        else float(cell)
                        if kind == "number"
                        else cell.lower() == "true"
                        if kind == "checkbox"
                        else select_label_to_id[number][cell]
                        if kind == "select"
                        else cell
                    )
                markdown = "\n".join(
                    f"{name}: {cell}" for name, cell in zip(headers, row, strict=True)
                )
                items.append(
                    Item(
                        f"notion:row:{path}:{index}",
                        (row[0] or "Row " + str(index))[:200],
                        markdown,
                        key,
                        values=values,
                        collection_key=key,
                    )
                )
        if len(items) > MAX_ITEMS:
            raise ExtensionRefusedError("import_item_bound", 413)
    if not items:
        raise ExtensionRefusedError("import_notion_no_pages")
    ordered: list[Item] = []
    pending = {item.external_key: item for item in items}
    while pending:
        done = {item.external_key for item in ordered}
        ready = sorted(
            (
                item
                for item in pending.values()
                if item.parent_key is None or item.parent_key in done
            ),
            key=lambda item: item.external_key,
        )
        if not ready:
            raise ExtensionRefusedError("import_notion_parent_cycle")
        for item in ready:
            ordered.append(item)
            del pending[item.external_key]
    return Parsed(tuple(ordered), len(files) - len(paths))


def parse(source: str, raw: bytes | BinaryIO) -> Parsed:
    try:
        if not isinstance(raw, bytes) and not hasattr(raw, "read"):
            raise ExtensionRefusedError("import_archive_bound", 413)
        if isinstance(raw, bytes) and (not raw or len(raw) > MAX_ARCHIVE):
            raise ExtensionRefusedError("import_archive_bound", 413)
        parser = {"slack": slack, "discord": discord, "notion": notion}.get(source)
        if parser is None:
            raise ExtensionRefusedError("import_source_unknown")
        result = parser(raw)
        if len({item.external_key for item in result.items}) != len(result.items) or any(
            not item.title for item in result.items
        ):
            raise ExtensionRefusedError("import_duplicate_object")
        return result
    except ExtensionRefusedError:
        raise
    except (ValueError, KeyError, TypeError, AttributeError, RecursionError):
        raise ExtensionRefusedError("import_export_schema") from None
