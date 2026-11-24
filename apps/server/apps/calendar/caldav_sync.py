"""Bidirectional SSRF-guarded CalDAV adapter (PROPFIND / REPORT sync-collection / PUT / DELETE)."""

from __future__ import annotations

import base64
import time
import xml.etree.ElementTree as ET
import xml.parsers.expat as expat
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import unquote, urljoin, urlsplit
from xml.sax.saxutils import escape as xml_escape

from apps.media.outbound import (
    BlockedTargetError,
    FetchError,
    Target,
    request as outbound_request,
    target as parse_target,
)

from .ics import IcsEvent, IcsFormatError, parse_calendar, serialize_calendar
from .sealing import CalDavCredentialError, CalDavSecretConfig, canonicalize_calendar_collection_url

MAX_CALDAV_WIRE_BYTES = 1024 * 1024
MAX_MULTISTATUS_RESPONSES = 2_000
DEFAULT_CALDAV_TIMEOUT_S = 8.0
DAV_NS = "DAV:"
CALDAV_NS = "urn:ietf:params:xml:ns:caldav"
CS_NS = "http://calendarserver.org/ns/"


class CalDavError(ValueError):
    """CalDAV transport, protocol, or security violation."""

    def __init__(self, code: str, message: str = "CalDAV operation refused") -> None:
        super().__init__(message)
        self.code = code


class CalDavBlockedError(CalDavError):
    """SSRF target block or redirect refusal."""


class CalDavConflictError(CalDavError):
    """Optimistic concurrency ETag mismatch (HTTP 412)."""


class CalDavSyncTokenExpiredError(CalDavError):
    """Server rejected incremental sync-token (HTTP 403/409/410 valid-sync-token)."""


@dataclass(frozen=True)
class CalDavRawResponse:
    status: int
    headers: dict[str, str]
    body: bytes


class CalDavTransport(Protocol):
    def __call__(
        self,
        destination: Target,
        *,
        method: str,
        headers: dict[str, str],
        body: bytes | None,
        deadline: float,
    ) -> CalDavRawResponse: ...


@dataclass(frozen=True)
class CalDavCollectionInfo:
    display_name: str
    ctag: str
    sync_token: str
    supports_calendar: bool


@dataclass(frozen=True)
class CalDavResourceDelta:
    href: str
    etag: str
    deleted: bool
    events: tuple[IcsEvent, ...] = ()


@dataclass(frozen=True)
class CalDavSyncBatch:
    sync_token: str
    deltas: tuple[CalDavResourceDelta, ...]
    full_resync: bool = False


def pinned_https_transport(
    destination: Target,
    *,
    method: str,
    headers: dict[str, str],
    body: bytes | None,
    deadline: float,
    nameservers: Sequence[tuple[str, int]] | None = None,
    scope_key: str | None = None,
) -> CalDavRawResponse:
    """Execute one HTTPS request over SSRF-pinned numeric TCP with zero redirect following."""
    if destination.scheme != "https":
        raise CalDavBlockedError("https_required", "CalDAV requires HTTPS")
    conn, resp = outbound_request(
        destination,
        deadline=deadline,
        method=method,
        body=body,
        headers=headers,
        pool="webhook",
        scope_key=scope_key,
        nameservers=nameservers,
        max_wire=MAX_CALDAV_WIRE_BYTES,
    )
    try:
        status = int(resp.status)
        resp_headers = {k.lower(): v for k, v in resp.getheaders()}
        if 300 <= status < 400:
            # Never follow redirects (prevents open-redirect -> loopback/metadata SSRF).
            raise CalDavBlockedError("redirect_refused", "CalDAV redirects are forbidden")
        payload = resp.read(MAX_CALDAV_WIRE_BYTES + 1)
        if len(payload) > MAX_CALDAV_WIRE_BYTES:
            raise CalDavError("response_too_large", "CalDAV response exceeds 1 MiB")
        return CalDavRawResponse(status=status, headers=resp_headers, body=payload)
    finally:
        conn.close()


def _safe_parse_xml(payload: bytes) -> ET.Element:
    if len(payload) > MAX_CALDAV_WIRE_BYTES:
        raise CalDavError("xml_too_large")
    full_upper = payload.upper()
    if b"<!DOCTYPE" in full_upper or b"<!ENTITY" in full_upper:
        raise CalDavError("xml_dtd_forbidden", "XML DTD and ENTITY declarations are forbidden")

    def _forbid_dtd(*_args: Any) -> None:
        raise CalDavError("xml_dtd_forbidden", "XML DTD and ENTITY declarations are forbidden")

    expat_guard = expat.ParserCreate("UTF-8")
    expat_guard.StartDoctypeDeclHandler = _forbid_dtd
    expat_guard.EntityDeclHandler = _forbid_dtd
    expat_guard.UnparsedEntityDeclHandler = _forbid_dtd
    expat_guard.NotationDeclHandler = _forbid_dtd
    expat_guard.ExternalEntityRefHandler = lambda *_a: 0
    try:
        text = payload.decode("utf-8")
        expat_guard.Parse(payload, True)
        return ET.fromstring(text)  # noqa: S314 - Expat guard above forbids all DTD, ENTITY, and external refs
    except CalDavError:
        raise
    except (UnicodeDecodeError, expat.ExpatError, ET.ParseError, RecursionError) as exc:
        raise CalDavError("malformed_xml", "Malformed WebDAV XML response") from exc


def _basic_auth_header(username: str, password: str) -> str:
    if ":" in username or any(ord(c) < 32 or ord(c) == 127 for c in username + password):
        raise CalDavError("invalid_credentials")
    token = base64.b64encode(f"{username}:{password}".encode()).decode("ascii")
    return f"Basic {token}"


def _clean_etag(raw: str) -> str:
    cleaned = raw.strip()
    if any(ord(c) < 32 or ord(c) == 127 for c in cleaned) or len(cleaned) > 255:
        raise CalDavError("invalid_etag")
    return cleaned


def _validate_safe_path_segments(raw_path: str) -> None:
    lower = raw_path.lower()
    if "%2f" in lower or "%5c" in lower or "%00" in lower or "\\" in raw_path:
        raise CalDavBlockedError("path_escape_href", "CalDAV href contains encoded slash or NUL")
    for seg in raw_path.split("/"):
        if seg in {".", ".."}:
            raise CalDavBlockedError("path_escape_href", "CalDAV href contains dot segment")
        decoded = unquote(seg)
        if (
            decoded in {".", ".."}
            or "/" in decoded
            or "\\" in decoded
            or "\x00" in decoded
            or any(ord(ch) < 32 or ord(ch) == 127 for ch in decoded)
        ):
            raise CalDavBlockedError("path_escape_href", "CalDAV href contains encoded traversal")


def _resolve_collection_href(base_target: Target, raw_href: str) -> Target:
    """Resolve an item href while strictly enforcing same-origin and collection path confinement."""
    cleaned = raw_href.strip()
    if (
        not cleaned
        or len(cleaned) > 2048
        or "?" in cleaned
        or "#" in cleaned
        or "\\" in cleaned
        or any(ord(c) <= 32 or ord(c) == 127 for c in cleaned)
    ):
        raise CalDavBlockedError("invalid_href")

    raw_parts = urlsplit(cleaned)
    if raw_parts.query or raw_parts.fragment:
        raise CalDavBlockedError("invalid_href")
    _validate_safe_path_segments(raw_parts.path)

    base_parts = urlsplit(base_target.url)
    base_path = base_parts.path.rstrip("/") + "/"
    canonical_base_url = f"{base_parts.scheme}://{base_parts.netloc}{base_path}"
    joined = urljoin(canonical_base_url, cleaned)
    try:
        resolved = parse_target(joined, https_only=True)
    except BlockedTargetError as exc:
        raise CalDavBlockedError("blocked_href") from exc
    if resolved.host != base_target.host or resolved.port != base_target.port:
        raise CalDavBlockedError("cross_origin_href", "CalDAV item href escaped collection origin")

    resolved_parts = urlsplit(resolved.url)
    if resolved_parts.query or resolved_parts.fragment:
        raise CalDavBlockedError("invalid_href")
    item_path = resolved_parts.path
    _validate_safe_path_segments(item_path)

    if item_path != base_path.rstrip("/") and not item_path.startswith(base_path):
        raise CalDavBlockedError("path_escape_href", "CalDAV item href escaped collection prefix")
    unquoted_base = unquote(base_path)
    unquoted_item = unquote(item_path)
    if unquoted_item != unquoted_base.rstrip("/") and not unquoted_item.startswith(unquoted_base):
        raise CalDavBlockedError("path_escape_href", "CalDAV item href escaped collection prefix")
    return resolved


def _parse_http_status_line(status_text: str) -> int:
    parts = status_text.strip().split()
    if len(parts) >= 2 and parts[0].startswith("HTTP/") and parts[1].isdigit():
        return int(parts[1])
    return 200


class CalDavAdapter:
    """SSRF-pinned bidirectional CalDAV client compatible with La Suite / Open-Xchange / Nextcloud."""

    def __init__(
        self,
        config: CalDavSecretConfig,
        *,
        transport: CalDavTransport | None = None,
        timeout_seconds: float = DEFAULT_CALDAV_TIMEOUT_S,
        scope_key: str | None = None,
    ) -> None:
        try:
            canonical_url = canonicalize_calendar_collection_url(config.calendar_url)
            self._base = parse_target(canonical_url, https_only=True)
        except (BlockedTargetError, CalDavCredentialError) as exc:
            raise CalDavBlockedError("blocked_target") from exc
        self._auth = _basic_auth_header(config.username, config.password)
        self._timeout = timeout_seconds
        self._scope_key = scope_key
        if transport is not None:
            self._transport = transport
        else:
            self._transport = self._default_transport

    def _default_transport(
        self,
        destination: Target,
        *,
        method: str,
        headers: dict[str, str],
        body: bytes | None,
        deadline: float,
    ) -> CalDavRawResponse:
        try:
            return pinned_https_transport(
                destination,
                method=method,
                headers=headers,
                body=body,
                deadline=deadline,
                scope_key=self._scope_key,
            )
        except BlockedTargetError as exc:
            raise CalDavBlockedError(exc.reason) from exc
        except FetchError as exc:
            raise CalDavError(exc.reason, "CalDAV server unreachable") from exc

    def _call(
        self,
        destination: Target,
        *,
        method: str,
        body: bytes | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> CalDavRawResponse:
        deadline = time.monotonic() + self._timeout
        headers = {
            "Authorization": self._auth,
            "User-Agent": "Kodera-CalDAV/1.0",
            **(extra_headers or {}),
        }
        return self._transport(
            destination,
            method=method,
            headers=headers,
            body=body,
            deadline=deadline,
        )

    def discover_collection(self) -> CalDavCollectionInfo:
        xml_body = (
            b'<?xml version="1.0" encoding="utf-8"?>'
            b'<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" '
            b'xmlns:cs="http://calendarserver.org/ns/">'
            b"<d:prop>"
            b"<d:displayname/><d:resourcetype/><d:sync-token/><cs:getctag/>"
            b"</d:prop>"
            b"</d:propfind>"
        )
        resp = self._call(
            self._base,
            method="PROPFIND",
            body=xml_body,
            extra_headers={
                "Depth": "0",
                "Content-Type": "application/xml; charset=utf-8",
            },
        )
        if resp.status in {401, 403}:
            raise CalDavError("auth_failed", "CalDAV authentication failed")
        if resp.status not in {200, 207}:
            raise CalDavError(f"http_{resp.status}", "CalDAV PROPFIND failed")

        root = _safe_parse_xml(resp.body)
        display_name = ""
        ctag = ""
        sync_token = ""
        supports_calendar = False

        for prop in root.findall(f".//{{{DAV_NS}}}prop"):
            dn = prop.find(f"{{{DAV_NS}}}displayname")
            if dn is not None and dn.text:
                display_name = dn.text.strip()[:128]
            st = prop.find(f"{{{DAV_NS}}}sync-token")
            if st is not None and st.text:
                sync_token = st.text.strip()[:1024]
            ct = prop.find(f"{{{CS_NS}}}getctag")
            if ct is not None and ct.text:
                ctag = ct.text.strip()[:255]
            rt = prop.find(f"{{{DAV_NS}}}resourcetype")
            if rt is not None and rt.find(f"{{{CALDAV_NS}}}calendar") is not None:
                supports_calendar = True

        return CalDavCollectionInfo(
            display_name=display_name,
            ctag=ctag,
            sync_token=sync_token,
            supports_calendar=supports_calendar,
        )

    def sync_collection(self, *, sync_token: str = "") -> CalDavSyncBatch:
        """Perform RFC 6578 incremental sync-collection REPORT (falling back on token expiry)."""
        if any(ord(c) < 32 or ord(c) == 127 for c in sync_token) or len(sync_token) > 1024:
            raise CalDavError("invalid_sync_token")
        escaped_token = xml_escape(sync_token)
        xml_body = (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<d:sync-collection xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
            f"<d:sync-token>{escaped_token}</d:sync-token>"
            "<d:sync-level>1</d:sync-level>"
            "<d:prop><d:getetag/><c:calendar-data/></d:prop>"
            "</d:sync-collection>"
        ).encode()
        resp = self._call(
            self._base,
            method="REPORT",
            body=xml_body,
            extra_headers={
                "Depth": "1",
                "Content-Type": "application/xml; charset=utf-8",
            },
        )
        if resp.status in {403, 409, 410} and sync_token:
            if b"valid-sync-token" in resp.body or resp.status == 410:
                batch = self.query_all_events()
                return CalDavSyncBatch(
                    sync_token=batch.sync_token,
                    deltas=batch.deltas,
                    full_resync=True,
                )
        if resp.status in {401, 403}:
            raise CalDavError("auth_failed", "CalDAV authentication failed")
        if resp.status not in {200, 207}:
            raise CalDavError(f"http_{resp.status}", "CalDAV REPORT failed")
        return self._parse_multistatus(resp.body, fallback_sync_token=sync_token)

    def query_all_events(self) -> CalDavSyncBatch:
        """Full calendar-query REPORT for servers without sync-token or after token expiry."""
        xml_body = (
            b'<?xml version="1.0" encoding="utf-8"?>'
            b'<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
            b"<d:prop><d:getetag/><c:calendar-data/></d:prop>"
            b"<c:filter>"
            b'<c:comp-filter name="VCALENDAR">'
            b'<c:comp-filter name="VEVENT"/>'
            b"</c:comp-filter>"
            b"</c:filter>"
            b"</c:calendar-query>"
        )
        resp = self._call(
            self._base,
            method="REPORT",
            body=xml_body,
            extra_headers={
                "Depth": "1",
                "Content-Type": "application/xml; charset=utf-8",
            },
        )
        if resp.status in {401, 403}:
            raise CalDavError("auth_failed", "CalDAV authentication failed")
        if resp.status not in {200, 207}:
            raise CalDavError(f"http_{resp.status}", "CalDAV calendar-query failed")
        batch = self._parse_multistatus(resp.body, fallback_sync_token="")
        return CalDavSyncBatch(
            sync_token=batch.sync_token,
            deltas=batch.deltas,
            full_resync=True,
        )

    def _parse_multistatus(self, xml_bytes: bytes, *, fallback_sync_token: str) -> CalDavSyncBatch:
        root = _safe_parse_xml(xml_bytes)
        top_token_el = root.find(f"{{{DAV_NS}}}sync-token")
        next_token = (
            top_token_el.text.strip()[:1024]
            if top_token_el is not None and top_token_el.text
            else fallback_sync_token
        )

        responses = root.findall(f"{{{DAV_NS}}}response")
        if len(responses) > MAX_MULTISTATUS_RESPONSES:
            raise CalDavError(
                "multistatus_too_large",
                "CalDAV multistatus response count exceeds safety limit",
            )

        deltas: list[CalDavResourceDelta] = []
        base_path = urlsplit(self._base.url).path.rstrip("/")
        for response_el in responses:
            href_el = response_el.find(f"{{{DAV_NS}}}href")
            if href_el is None or not href_el.text:
                continue
            resolved_href = _resolve_collection_href(self._base, href_el.text)
            item_path = urlsplit(resolved_href.url).path.rstrip("/")
            if item_path == base_path:
                continue

            top_status_el = response_el.find(f"{{{DAV_NS}}}status")
            if top_status_el is not None and top_status_el.text:
                if _parse_http_status_line(top_status_el.text) == 404:
                    deltas.append(
                        CalDavResourceDelta(href=resolved_href.url, etag="", deleted=True)
                    )
                    continue

            etag = ""
            ics_text = ""
            for propstat in response_el.findall(f"{{{DAV_NS}}}propstat"):
                ps_status_el = propstat.find(f"{{{DAV_NS}}}status")
                code = (
                    _parse_http_status_line(ps_status_el.text)
                    if ps_status_el is not None and ps_status_el.text
                    else 200
                )
                if code == 404:
                    continue
                prop = propstat.find(f"{{{DAV_NS}}}prop")
                if prop is None:
                    continue
                etag_el = prop.find(f"{{{DAV_NS}}}getetag")
                if etag_el is not None and etag_el.text:
                    etag = _clean_etag(etag_el.text)
                cal_el = prop.find(f"{{{CALDAV_NS}}}calendar-data")
                if cal_el is not None and cal_el.text:
                    ics_text = cal_el.text

            if not ics_text.strip():
                continue
            try:
                parsed = parse_calendar(ics_text, lenient_inbound=True)
            except IcsFormatError as exc:
                raise CalDavError("invalid_remote_ics", str(exc)) from exc
            if parsed.events:
                deltas.append(
                    CalDavResourceDelta(
                        href=resolved_href.url,
                        etag=etag,
                        deleted=False,
                        events=parsed.events,
                    )
                )

        return CalDavSyncBatch(sync_token=next_token, deltas=tuple(deltas), full_resync=False)

    def put_event(
        self,
        event: IcsEvent,
        *,
        remote_href: str = "",
        expected_etag: str | None = None,
    ) -> tuple[str, str]:
        """Create or update a VEVENT via PUT with If-None-Match / If-Match optimistic concurrency."""
        if remote_href:
            dest = _resolve_collection_href(self._base, remote_href)
        else:
            safe_uid = "".join(ch for ch in event.uid if ch.isalnum() or ch in {"-", "_", "."})[
                :120
            ]
            if not safe_uid:
                raise CalDavError("invalid_uid")
            base_with_slash = self._base.url.rstrip("/") + "/"
            dest = _resolve_collection_href(self._base, f"{base_with_slash}{safe_uid}.ics")

        ics_bytes = serialize_calendar(events=(event,), method="PUBLISH").encode("utf-8")
        cond_headers: dict[str, str] = {
            "Content-Type": "text/calendar; charset=utf-8",
        }
        if expected_etag:
            cond_headers["If-Match"] = _clean_etag(expected_etag)
        elif not remote_href:
            cond_headers["If-None-Match"] = "*"

        resp = self._call(dest, method="PUT", body=ics_bytes, extra_headers=cond_headers)
        if resp.status == 412:
            raise CalDavConflictError("etag_conflict", "Remote CalDAV event changed concurrently")
        if resp.status in {401, 403}:
            raise CalDavError("auth_failed", "CalDAV authentication failed")
        if resp.status not in {200, 201, 204}:
            raise CalDavError(f"http_{resp.status}", "CalDAV PUT failed")
        new_etag = _clean_etag(resp.headers.get("etag", ""))
        return dest.url, new_etag

    def delete_event(self, *, remote_href: str, expected_etag: str | None = None) -> None:
        """Delete a remote VEVENT resource with optional ETag precondition."""
        dest = _resolve_collection_href(self._base, remote_href)
        cond_headers: dict[str, str] = {}
        if expected_etag:
            cond_headers["If-Match"] = _clean_etag(expected_etag)
        resp = self._call(dest, method="DELETE", extra_headers=cond_headers)
        if resp.status == 412:
            raise CalDavConflictError("etag_conflict", "Remote CalDAV event changed before DELETE")
        if resp.status == 404:
            return
        if resp.status in {401, 403}:
            raise CalDavError("auth_failed", "CalDAV authentication failed")
        if resp.status not in {200, 202, 204}:
            raise CalDavError(f"http_{resp.status}", "CalDAV DELETE failed")


def build_adapter_factory() -> Callable[[CalDavSecretConfig, str | None], CalDavAdapter]:
    return lambda cfg, scope_key: CalDavAdapter(cfg, scope_key=scope_key)
