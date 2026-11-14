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
from typing import Any

from .wire import ExtensionRefusedError, canonical

MAX_ARCHIVE, MAX_EXPANDED, MAX_FILE, MAX_ITEMS = (
    20 * 1024 * 1024,
    40 * 1024 * 1024,
    2 * 1024 * 1024,
    500,
)
ID = re.compile(r"[A-Za-z0-9_.-]{1,128}\Z")


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
class Parsed:
    items: tuple[Item, ...]
    omitted_assets: int = 0


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


def clean(value: Any, maximum: int = 60000) -> str:
    if (
        not isinstance(value, str)
        or len(value) > maximum
        or any(0xD800 <= ord(c) <= 0xDFFF for c in value)
    ):
        raise ExtensionRefusedError("import_text_bound")
    value = re.sub(r"!\[[^\]]*\]\([^\n)]*\)", "[image omitted]", value)
    value = re.sub(r"\[([^\]]*)\]\([^\n)]*\)", lambda match: match[1], value)
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


def identifier(value: Any) -> str:
    if not isinstance(value, str) or ID.fullmatch(value) is None:
        raise ExtensionRefusedError("import_external_id_invalid")
    return value


def text_file(raw: bytes) -> str:
    try:
        return raw.decode("utf-8-sig")
    except UnicodeError:
        raise ExtensionRefusedError("import_utf8_required") from None


def archive(raw: bytes) -> dict[str, bytes]:
    if not raw or len(raw) > MAX_ARCHIVE:
        raise ExtensionRefusedError("import_archive_bound", 413)
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as source:
            files, seen, total = {}, set(), 0
            entries = source.infolist()
            if len(entries) > 1000:
                raise ExtensionRefusedError("import_archive_bound", 413)
            # Other codecs can allocate an unbounded expansion/dictionary before ZipExtFile
            # slices to the advertised size. Preflight every entry before opening any member.
            if any(
                info.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
                for info in entries
            ):
                raise ExtensionRefusedError("import_archive_compression")
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
                total += info.file_size
                if (
                    info.file_size > MAX_FILE
                    or total > MAX_EXPANDED
                    or info.file_size > max(1, info.compress_size) * 100
                ):
                    raise ExtensionRefusedError("import_archive_bound", 413)
                with source.open(info) as stream:
                    content = stream.read(MAX_FILE + 1)
                if len(content) != info.file_size or len(content) > MAX_FILE:
                    raise ExtensionRefusedError("import_archive_bound", 413)
                files[name] = content
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


def slack(raw: bytes) -> Parsed:
    files = archive(raw)
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
    authors = {
        identifier(row["id"]): clean(
            row.get("profile", {}).get("display_name")
            or row.get("real_name")
            or row.get("name")
            or row["id"],
            200,
        )
        for row in users
    }
    items: list[Item] = []
    omitted = 0
    for channel in channels:
        channel_id, name = identifier(channel["id"]), clean(channel["name"], 200)
        folder = channel["name"]
        if not name or "/" in folder or "\\" in folder:
            raise ExtensionRefusedError("import_slack_channel")
        parent = "slack:channel:" + channel_id
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
                omitted += len(message.get("files", [])) + len(message.get("attachments", []))
                content = (
                    f"Imported author: {authors.get(author, author)} (Slack {author})\nSource timestamp: {stamp}\n\n"
                    + clean(message.get("text", ""))
                )
                items.append(
                    Item(f"slack:message:{channel_id}:{stamp}", "Message " + stamp, content, parent)
                )
                if len(items) > MAX_ITEMS:
                    raise ExtensionRefusedError("import_item_bound", 413)
    return Parsed(tuple(items), omitted)


def discord(raw: bytes) -> Parsed:
    value = document(raw)
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("channel"), dict)
        or not isinstance(value.get("messages"), list)
    ):
        raise ExtensionRefusedError("import_discord_schema")
    channel_id = identifier(value["channel"]["id"])
    parent = "discord:channel:" + channel_id
    items = [
        Item(parent, clean(value["channel"]["name"], 200), "Imported Discord channel " + channel_id)
    ]
    omitted = 0
    for message in value["messages"]:
        message_id = identifier(message["id"])
        author = message.get("author", {})
        author_id = identifier(author["id"])
        name = clean(author.get("nickname") or author.get("name") or author_id, 200)
        stamp = message.get("timestamp")
        if (
            not isinstance(stamp, str)
            or datetime.fromisoformat(stamp.replace("Z", "+00:00")).tzinfo is None
        ):
            raise ExtensionRefusedError("import_discord_timestamp")
        omitted += len(message.get("attachments", [])) + len(message.get("embeds", []))
        content = (
            f"Imported author: {name} (Discord {author_id})\nSource timestamp: {stamp}\n\n"
            + clean(message.get("content", ""))
        )
        items.append(
            Item(
                f"discord:message:{channel_id}:{message_id}",
                "Message " + message_id,
                content,
                parent,
            )
        )
        if len(items) > MAX_ITEMS:
            raise ExtensionRefusedError("import_item_bound", 413)
    return Parsed(tuple(items), omitted)


def column(values: list[str]) -> str:
    filled = [value for value in values if value]
    if (
        filled
        and len(filled) == len(values)
        and all(value.lower() in {"true", "false"} for value in filled)
    ):
        return "checkbox"
    if filled and all(
        re.fullmatch(r"-?(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?", value)
        and math.isfinite(float(value))
        for value in filled
    ):
        return "number"
    if filled:
        try:
            if all(date.fromisoformat(value).isoformat() == value for value in filled):
                return "date"
        except ValueError:
            pass
    return "text"


def notion(raw: bytes) -> Parsed:
    files = archive(raw)
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
            clean(PurePosixPath(directory).name, 200),
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
        title = clean(location.stem, 200)
        if path.lower().endswith(".md"):
            items.append(Item(key, title, clean(text_file(files[path])), parent))
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
            types = [column([row[index] for row in data]) for index in range(len(headers))]
            properties = tuple(
                {"id": "c" + str(index), "name": name, "type": types[index]}
                for index, name in enumerate(headers)
            )
            items.append(Item(key, title, "Imported Notion CSV table", parent, properties))
            for index, row in enumerate(data, 1):
                values = {}
                for number, cell in enumerate(row):
                    kind = types[number]
                    values["c" + str(number)] = (
                        None
                        if not cell
                        else float(cell)
                        if kind == "number"
                        else cell.lower() == "true"
                        if kind == "checkbox"
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


def parse(source: str, raw: bytes) -> Parsed:
    try:
        if not isinstance(raw, bytes) or len(raw) > MAX_ARCHIVE:
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
