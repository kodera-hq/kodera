"""Bounded URL previews. No returned string is HTML and no redirect bypasses pinning."""

from __future__ import annotations

import html
import http.client
import re
import time
import unicodedata
from html.parser import HTMLParser
from urllib.parse import urljoin

from .outbound import BlockedTargetError, FetchError, remaining, request, target

MAX_BODY = 256 * 1024
MAX_SECONDS = 3
MAX_REDIRECTS = 3
REDIRECTS = frozenset({301, 302, 303, 307, 308})


class _Plain(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.ignored = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style"}:
            self.ignored += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style"} and self.ignored:
            self.ignored -= 1

    def handle_data(self, data: str) -> None:
        if not self.ignored:
            self.parts.append(data)


def plain(value: str, limit: int) -> str:
    parser = _Plain()
    parser.feed(html.unescape(value))
    text = "".join(parser.parts)
    text = "".join(
        character
        for character in text
        if character not in "<>"
        and (character.isspace() or unicodedata.category(character)[0] != "C")
    )
    return re.sub(r"\s+", " ", text).strip()[:limit]


class Metadata(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.canonical: str | None = None
        self.titles: list[str] = []
        self.in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "meta":
            name = values.get("property") or values.get("name")
            content = values.get("content")
            if name and isinstance(content, str):
                self.meta.setdefault(name.lower(), content)
        elif tag == "link" and "canonical" in (values.get("rel") or "").lower().split():
            self.canonical = self.canonical or values.get("href")
        elif tag == "title":
            self.in_title = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self.in_title = False

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.titles.append(data)


def unfurl(url: str) -> dict[str, str]:
    deadline = time.monotonic() + MAX_SECONDS
    original = target(url)
    current = original
    seen: set[str] = set()
    body = b""
    for hop in range(MAX_REDIRECTS + 1):
        if current.url in seen:
            raise BlockedTargetError()
        seen.add(current.url)
        connection = response = None
        try:
            connection, response = request(
                current,
                deadline=deadline,
                headers={"Accept": "text/html", "User-Agent": "kodera-unfurl/1"},
            )
            if response.status in REDIRECTS:
                locations = response.headers.get_all("Location", [])
                if hop == MAX_REDIRECTS or len(locations) != 1:
                    raise BlockedTargetError()
                current = target(urljoin(current.url, locations[0]))
                continue
            if response.status != 200:
                raise FetchError()
            if (
                response.getheader("Content-Type", "").split(";")[0].strip().lower() != "text/html"
                or response.getheader("Content-Encoding", "identity").lower() != "identity"
            ):
                raise FetchError("unsupported-content")
            length = response.getheader("Content-Length")
            if length is not None and (
                len(length) > 9
                or not length.isascii()
                or not length.isdigit()
                or int(length) > MAX_BODY
                or response.chunked
            ):
                raise FetchError("too-large")
            chunks = []
            received = 0
            while True:
                remaining(deadline)
                chunk = response.read1(min(8192, MAX_BODY + 1 - received))
                if not chunk:
                    break
                chunks.append(chunk)
                received += len(chunk)
                if received > MAX_BODY:
                    raise FetchError("too-large")
            if length is not None and received != int(length):
                raise FetchError("truncated")
            body = b"".join(chunks)
            break
        except (OSError, http.client.HTTPException):
            raise FetchError() from None
        finally:
            if response is not None:
                response.close()
            if connection is not None:
                connection.close()
    metadata = Metadata()
    metadata.feed(body.decode("utf-8", errors="replace"))
    canonical = current.url
    if metadata.canonical:
        try:
            candidate = target(urljoin(current.url, metadata.canonical))
            # Reuse the validated origin. Cross-origin canonical metadata is omitted.
            if (candidate.scheme, candidate.host, candidate.port) == (
                current.scheme,
                current.host,
                current.port,
            ):
                canonical = candidate.url
        except (BlockedTargetError, FetchError):
            pass
    remaining(deadline)
    # Images are omitted until their bytes, MIME and dimensions are independently validated.
    result = {
        "url": original.url,
        "canonicalUrl": canonical,
        "title": plain(metadata.meta.get("og:title") or "".join(metadata.titles), 512),
        "description": plain(
            metadata.meta.get("og:description") or metadata.meta.get("description", ""),
            2000,
        ),
        "siteName": plain(metadata.meta.get("og:site_name", ""), 255),
    }
    remaining(deadline)
    return result
