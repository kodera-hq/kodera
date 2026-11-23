"""Bounded async HTTP/1.1 write-admission proxy ahead of Gunicorn on `api_ingress`.

Buffers full `<= 1 MiB` request bodies under a strict 10-second wall-clock deadline before
opening an upstream socket to `server:8000`, isolating Gunicorn's `gthread` workers and
`BodyGuard` slots from slow-trickling writers while preserving fair shared-NAT bursts.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import ipaddress
import json
import math
import os
import re
import signal
import socket
import time
from collections import OrderedDict
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Final

from config.deploy_environment import ImproperlyConfigured, _refuse_unsafe
from config.environment import trusted_edge
from core.api.edge import Network, client_address

HEADER_READ_SECONDS: Final[float] = 10.0
BODY_READ_SECONDS: Final[float] = 10.0
UPSTREAM_CONNECT_SECONDS: Final[float] = 5.0
UPSTREAM_RESPONSE_SECONDS: Final[float] = 35.0
BODY_MAX_BYTES: Final[int] = 1_048_576
MAX_HEADER_BYTES: Final[int] = 32_768
MAX_HEADER_LINES: Final[int] = 100
MAX_TARGET_BYTES: Final[int] = 8_192
MAX_CHUNK_LINE_BYTES: Final[int] = 256
STREAM_READER_LIMIT: Final[int] = 16_384
SOCKET_RCVBUF_BYTES: Final[int] = 32_768

DEFAULT_MAX_CONNECTIONS: Final[int] = 256
DEFAULT_GLOBAL_BODY_SLOTS: Final[int] = 32
DEFAULT_MAX_GLOBAL_BODY_BYTES: Final[int] = 33_554_432
DEFAULT_PER_IP_BODY_SLOTS: Final[int] = 8
DEFAULT_PER_IP_QUEUE_WAIT_SECONDS: Final[float] = 0.25
DEFAULT_PER_IP_WRITE_RATE: Final[float] = 20.0
DEFAULT_PER_IP_WRITE_BURST: Final[int] = 120
DEFAULT_MAX_TRACKED_IPS: Final[int] = 4_096
# Gunicorn runs 2 gthread workers x 4 threads, with BODY_READ_SLOTS = 2 per worker.
# Pacing buffered upstream writes to 2 guarantees zero per-worker BodyGuard 503s even
# when the OS kernel routes both concurrent upstream sockets to the same worker.
DEFAULT_UPSTREAM_WRITE_CONCURRENCY: Final[int] = 2
DEFAULT_UPSTREAM_READ_CONCURRENCY: Final[int] = 6
DEFAULT_UPSTREAM_QUEUE_WAIT_SECONDS: Final[float] = 10.0

ALLOWED_METHODS: Final[frozenset[str]] = frozenset(
    {"GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"}
)
MUTATING_METHODS: Final[frozenset[str]] = frozenset({"POST", "PUT", "PATCH", "DELETE"})
HOP_BY_HOP_HEADERS: Final[frozenset[str]] = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "expect",
    }
)
# RFC 9110 tchar without `_`: underscore header names are refused at the edge (matching Gunicorn
# `header_map = "refuse"`) so forged underscore aliases cannot collide with normalized headers.
HEADER_NAME_RE: Final[re.Pattern[str]] = re.compile(r"\A[!#$%&'*+.^`|~0-9A-Za-z-]+\Z")
HEX_DIGITS_RE: Final[re.Pattern[bytes]] = re.compile(rb"\A[0-9a-fA-F]{1,8}\Z")


class _ProtocolRefusalError(Exception):
    def __init__(
        self,
        status: int,
        reason: str,
        detail: str,
        retry_after: int | None = None,
        *,
        response_started: bool = False,
    ):
        super().__init__(detail)
        self.status = status
        self.reason = reason
        self.detail = detail
        self.retry_after = retry_after
        self.response_started = response_started


@dataclass(frozen=True)
class AdmissionConfig:
    listen_host: str = "0.0.0.0"  # noqa: S104 - container-only api_ingress listener
    listen_port: int = 8080
    upstream_host: str = "server"
    upstream_port: int = 8000
    trusted_edges: tuple[Network, ...] = ()
    require_trusted_edge: bool = False
    max_connections: int = DEFAULT_MAX_CONNECTIONS
    global_body_slots: int = DEFAULT_GLOBAL_BODY_SLOTS
    max_global_body_bytes: int = DEFAULT_MAX_GLOBAL_BODY_BYTES
    per_ip_body_slots: int = DEFAULT_PER_IP_BODY_SLOTS
    per_ip_queue_wait_seconds: float = DEFAULT_PER_IP_QUEUE_WAIT_SECONDS
    per_ip_write_rate: float = DEFAULT_PER_IP_WRITE_RATE
    per_ip_write_burst: int = DEFAULT_PER_IP_WRITE_BURST
    max_tracked_ips: int = DEFAULT_MAX_TRACKED_IPS
    upstream_write_concurrency: int = DEFAULT_UPSTREAM_WRITE_CONCURRENCY
    upstream_read_concurrency: int = DEFAULT_UPSTREAM_READ_CONCURRENCY
    upstream_queue_wait_seconds: float = DEFAULT_UPSTREAM_QUEUE_WAIT_SECONDS
    header_read_seconds: float = HEADER_READ_SECONDS
    body_read_seconds: float = BODY_READ_SECONDS
    body_max_bytes: int = BODY_MAX_BYTES


@dataclass
class _TokenBucketEntry:
    tokens: float
    updated_at: float


class BurstTokenBucket:
    """Bounded-memory per-client-IP token bucket tolerating shared-NAT reconnection bursts."""

    def __init__(
        self,
        *,
        rate_per_second: float,
        burst: int,
        max_keys: int = DEFAULT_MAX_TRACKED_IPS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._rate = rate_per_second
        self._burst = float(burst)
        self._max_keys = max_keys
        self._clock = clock
        self._entries: OrderedDict[str, _TokenBucketEntry] = OrderedDict()

    def charge(self, key: str) -> int | None:
        """Consume one write token; return `None` when admitted or integer `Retry-After` seconds."""
        now = self._clock()
        entry = self._entries.get(key)
        if entry is None:
            entry = _TokenBucketEntry(tokens=self._burst, updated_at=now)
            self._entries[key] = entry
            while len(self._entries) > self._max_keys:
                self._entries.popitem(last=False)
        else:
            elapsed = max(0.0, now - entry.updated_at)
            entry.tokens = min(self._burst, entry.tokens + elapsed * self._rate)
            entry.updated_at = now
            self._entries.move_to_end(key)

        if entry.tokens >= 1.0:
            entry.tokens -= 1.0
            return None
        deficit = 1.0 - entry.tokens
        wait = deficit / self._rate if self._rate > 0 else 1.0
        return max(1, math.ceil(wait))

    def __len__(self) -> int:
        return len(self._entries)


@dataclass
class _IpSlotEntry:
    semaphore: asyncio.Semaphore
    active_or_waiting: int = 0


class PerClientBodySlots:
    """Bounded per-client-IP concurrent body-reader gate with micro-burst queue tolerance."""

    def __init__(self, *, limit_per_ip: int, max_keys: int = DEFAULT_MAX_TRACKED_IPS) -> None:
        self._limit = limit_per_ip
        self._max_keys = max_keys
        self._entries: OrderedDict[str, _IpSlotEntry] = OrderedDict()

    @contextlib.asynccontextmanager
    async def acquire(self, key: str, *, timeout: float):
        entry = self._entries.get(key)
        if entry is None:
            if len(self._entries) >= self._max_keys:
                for candidate_key in list(self._entries.keys()):
                    if self._entries[candidate_key].active_or_waiting == 0:
                        del self._entries[candidate_key]
                        if len(self._entries) < self._max_keys:
                            break
            if len(self._entries) >= self._max_keys:
                raise _ProtocolRefusalError(
                    503,
                    "Service Unavailable",
                    "Edge client admission table busy.",
                    retry_after=1,
                )
            entry = _IpSlotEntry(semaphore=asyncio.Semaphore(self._limit))
            self._entries[key] = entry
        else:
            self._entries.move_to_end(key)

        entry.active_or_waiting += 1
        acquired = False
        try:
            try:
                if timeout <= 0:
                    if entry.semaphore.locked():
                        raise TimeoutError
                    await entry.semaphore.acquire()
                else:
                    async with asyncio.timeout(timeout):
                        await entry.semaphore.acquire()
                acquired = True
            except TimeoutError:
                raise _ProtocolRefusalError(
                    429,
                    "Too Many Requests",
                    "Per-client concurrent body reader limit exceeded.",
                    retry_after=1,
                ) from None
            yield
        finally:
            if acquired:
                entry.semaphore.release()
            entry.active_or_waiting -= 1
            if entry.active_or_waiting == 0 and key in self._entries:
                del self._entries[key]


def normalize_client_bucket(raw_ip: str) -> str:
    """Normalize IPv4 addresses and aggregate IPv6 clients per /64 subnet."""
    try:
        parsed = ipaddress.ip_address(raw_ip.strip())
    except ValueError:
        return raw_ip.strip() or "unknown"
    if isinstance(parsed, ipaddress.IPv6Address):
        if parsed.ipv4_mapped is not None:
            return str(parsed.ipv4_mapped)
        return str(ipaddress.IPv6Network((parsed, 64), strict=False))
    return str(parsed)


def _peer_is_loopback(peer_ip: str) -> bool:
    try:
        parsed = ipaddress.ip_address(peer_ip)
    except ValueError:
        return False
    if isinstance(parsed, ipaddress.IPv6Address) and parsed.ipv4_mapped is not None:
        parsed = parsed.ipv4_mapped
    return parsed.is_loopback


def _peer_in_trusted(peer_ip: str, trusted: Sequence[Network]) -> bool:
    try:
        parsed = ipaddress.ip_address(peer_ip)
    except ValueError:
        return False
    if isinstance(parsed, ipaddress.IPv6Address) and parsed.ipv4_mapped is not None:
        parsed = parsed.ipv4_mapped
    return any(parsed in net for net in trusted)


def _meta_from_headers(peer_ip: str, headers: Sequence[tuple[str, str]]) -> dict[str, str]:
    meta: dict[str, str] = {"REMOTE_ADDR": peer_ip}
    for name, value in headers:
        if "_" in name or not HEADER_NAME_RE.fullmatch(name):
            raise _ProtocolRefusalError(400, "Bad Request", "Invalid request header name.")
        key = "HTTP_" + name.upper().replace("-", "_")
        if key in meta:
            meta[key] = meta[key] + ", " + value
        else:
            meta[key] = value
    return meta


@dataclass(frozen=True)
class _ParsedRequestHead:
    method: str
    target: str
    version: str
    headers: tuple[tuple[str, str], ...]
    content_length: int | None
    chunked: bool
    expect_continue: bool


def _parse_head(raw_head: bytes) -> _ParsedRequestHead:
    try:
        text = raw_head.decode("latin-1")
    except UnicodeDecodeError as exc:
        raise _ProtocolRefusalError(400, "Bad Request", "Malformed request headers.") from exc

    lines = text.split("\r\n")
    if not lines or len(lines) - 1 > MAX_HEADER_LINES:
        raise _ProtocolRefusalError(
            431, "Request Header Fields Too Large", "Too many request header lines."
        )
    request_line = lines[0]
    parts = request_line.split(" ")
    if len(parts) != 3 or any(not part for part in parts):
        raise _ProtocolRefusalError(400, "Bad Request", "Malformed HTTP request line.")
    method, target, version = parts
    if version not in {"HTTP/1.1", "HTTP/1.0"}:
        raise _ProtocolRefusalError(400, "Bad Request", "Unsupported HTTP version.")
    if method not in ALLOWED_METHODS:
        raise _ProtocolRefusalError(405, "Method Not Allowed", "HTTP method not permitted.")
    if (
        not target.startswith("/")
        or len(target) > MAX_TARGET_BYTES
        or any(ord(ch) <= 32 or ord(ch) == 127 for ch in target)
    ):
        raise _ProtocolRefusalError(400, "Bad Request", "Invalid request target.")

    headers: list[tuple[str, str]] = []
    host_count = 0
    content_lengths: list[int] = []
    transfer_encodings: list[str] = []
    expect_continue = False

    for line in lines[1:]:
        if not line:
            continue
        if line[0] in {" ", "\t"}:
            raise _ProtocolRefusalError(400, "Bad Request", "Obsolete line folding refused.")
        name, sep, raw_value = line.partition(":")
        if not sep or not HEADER_NAME_RE.fullmatch(name):
            raise _ProtocolRefusalError(400, "Bad Request", "Invalid request header name.")
        value = raw_value.strip(" \t")
        if any(ch in value for ch in ("\r", "\n", "\x00")):
            raise _ProtocolRefusalError(400, "Bad Request", "Invalid request header value.")
        lower = name.lower()
        if lower == "host":
            host_count += 1
            if not value or any(ch.isspace() for ch in value):
                raise _ProtocolRefusalError(400, "Bad Request", "Invalid Host header.")
        elif lower == "content-length":
            if not value.isascii() or not value.isdecimal():
                raise _ProtocolRefusalError(400, "Bad Request", "Invalid request body length.")
            content_lengths.append(int(value))
        elif lower == "transfer-encoding":
            transfer_encodings.extend(token.strip().lower() for token in value.split(","))
        elif lower == "expect":
            if value.lower() == "100-continue":
                expect_continue = True
            else:
                raise _ProtocolRefusalError(417, "Expectation Failed", "Unsupported Expect header.")
        headers.append((name, value))

    if version == "HTTP/1.1" and host_count != 1:
        raise _ProtocolRefusalError(400, "Bad Request", "HTTP/1.1 requires exactly one Host.")
    if host_count > 1:
        raise _ProtocolRefusalError(400, "Bad Request", "Duplicate Host header.")
    if transfer_encodings and content_lengths:
        raise _ProtocolRefusalError(
            400, "Bad Request", "Conflicting Transfer-Encoding and Content-Length."
        )
    chunked = False
    if transfer_encodings:
        if transfer_encodings != ["chunked"]:
            raise _ProtocolRefusalError(400, "Bad Request", "Unsupported Transfer-Encoding.")
        chunked = True
    content_length: int | None = None
    if content_lengths:
        if len(content_lengths) > 1:
            raise _ProtocolRefusalError(400, "Bad Request", "Duplicate Content-Length header.")
        content_length = content_lengths[0]

    return _ParsedRequestHead(
        method=method,
        target=target,
        version=version,
        headers=tuple(headers),
        content_length=content_length,
        chunked=chunked,
        expect_continue=expect_continue,
    )


class EdgeAdmissionServer:
    """Async HTTP/1.1 admission proxy buffering write bodies before connecting to Gunicorn."""

    def __init__(self, config: AdmissionConfig) -> None:
        self.config = config
        self._active_connections = 0
        self._active_body_slots = 0
        self._active_body_bytes = 0
        self._ip_body_slots = PerClientBodySlots(
            limit_per_ip=config.per_ip_body_slots,
            max_keys=config.max_tracked_ips,
        )
        self._rate_limiter = BurstTokenBucket(
            rate_per_second=config.per_ip_write_rate,
            burst=config.per_ip_write_burst,
            max_keys=config.max_tracked_ips,
        )
        self._upstream_write_sem = asyncio.Semaphore(config.upstream_write_concurrency)
        self._upstream_read_sem = asyncio.Semaphore(config.upstream_read_concurrency)
        self._server: asyncio.AbstractServer | None = None

    async def start(self) -> tuple[str, int]:
        self._server = await asyncio.start_server(
            self._handle_client,
            host=self.config.listen_host,
            port=self.config.listen_port,
            backlog=min(512, max(64, self.config.max_connections)),
            limit=STREAM_READER_LIMIT,
        )
        for srv_sock in self._server.sockets or ():
            with contextlib.suppress(OSError):
                srv_sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, SOCKET_RCVBUF_BYTES)
        sock = self._server.sockets[0]
        bound = sock.getsockname()
        return str(bound[0]), int(bound[1])

    @staticmethod
    def _pause_transport(writer: asyncio.StreamWriter) -> None:
        transport = writer.transport
        if isinstance(transport, asyncio.ReadTransport):
            with contextlib.suppress(OSError, RuntimeError):
                transport.pause_reading()

    @staticmethod
    def _resume_transport(writer: asyncio.StreamWriter) -> None:
        transport = writer.transport
        if isinstance(transport, asyncio.ReadTransport):
            with contextlib.suppress(OSError, RuntimeError):
                transport.resume_reading()

    async def close(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None

    async def _send_json(
        self,
        writer: asyncio.StreamWriter,
        status: int,
        reason: str,
        payload: Mapping[str, object],
        *,
        retry_after: int | None = None,
    ) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        lines = [
            f"HTTP/1.1 {status} {reason}",
            "Content-Type: application/json",
            "Cache-Control: no-store",
            f"Content-Length: {len(body)}",
            "Connection: close",
        ]
        if retry_after is not None:
            lines.append(f"Retry-After: {retry_after}")
        raw = ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1") + body
        with contextlib.suppress(OSError, ConnectionError):
            writer.write(raw)
            await writer.drain()

    async def _read_head_and_prefix(
        self, reader: asyncio.StreamReader
    ) -> tuple[_ParsedRequestHead, bytearray] | None:
        buf = bytearray()
        try:
            async with asyncio.timeout(self.config.header_read_seconds):
                while True:
                    idx = buf.find(b"\r\n\r\n")
                    if idx != -1:
                        raw_head = bytes(buf[:idx])
                        remainder = bytearray(buf[idx + 4 :])
                        return _parse_head(raw_head), remainder
                    if len(buf) > MAX_HEADER_BYTES:
                        raise _ProtocolRefusalError(
                            431,
                            "Request Header Fields Too Large",
                            "Request headers exceed 32 KiB.",
                        )
                    chunk = await reader.read(min(8192, MAX_HEADER_BYTES + 4 - len(buf)))
                    if not chunk:
                        if not buf:
                            return None
                        raise _ProtocolRefusalError(
                            400, "Bad Request", "Incomplete HTTP request headers."
                        )
                    buf.extend(chunk)
        except TimeoutError:
            raise _ProtocolRefusalError(
                408, "Request Timeout", "Request header read deadline exceeded."
            ) from None

    async def _read_fixed_body(
        self, reader: asyncio.StreamReader, prebuffer: bytearray, expected_length: int
    ) -> bytearray:
        if expected_length > self.config.body_max_bytes:
            raise _ProtocolRefusalError(413, "Payload Too Large", "Request body exceeds 1 MiB.")
        if len(prebuffer) > expected_length:
            raise _ProtocolRefusalError(400, "Bad Request", "Trailing bytes after request body.")
        body = prebuffer
        deadline = time.monotonic() + self.config.body_read_seconds
        try:
            async with asyncio.timeout_at(deadline):
                while len(body) < expected_length:
                    want = min(STREAM_READER_LIMIT, expected_length - len(body))
                    chunk = await reader.read(want)
                    if not chunk:
                        raise _ProtocolRefusalError(
                            400, "Bad Request", "Invalid or incomplete request body."
                        )
                    body.extend(chunk)
        except TimeoutError:
            body.clear()
            raise _ProtocolRefusalError(
                408, "Request Timeout", "Request body read deadline exceeded."
            ) from None
        return body

    async def _read_line_from(
        self, reader: asyncio.StreamReader, buf: bytearray, max_len: int
    ) -> bytes:
        while True:
            idx = buf.find(b"\r\n")
            if idx != -1:
                if idx > max_len:
                    raise _ProtocolRefusalError(400, "Bad Request", "Malformed chunk header.")
                line = bytes(buf[:idx])
                del buf[: idx + 2]
                return line
            if len(buf) > max_len + 2:
                raise _ProtocolRefusalError(400, "Bad Request", "Malformed chunk header.")
            more = await reader.read(min(8192, STREAM_READER_LIMIT))
            if not more:
                raise _ProtocolRefusalError(
                    400, "Bad Request", "Invalid or incomplete chunked request body."
                )
            buf.extend(more)

    async def _append_exact_from(
        self,
        reader: asyncio.StreamReader,
        buf: bytearray,
        dest: bytearray,
        length: int,
    ) -> None:
        remaining = length
        if buf:
            take = min(len(buf), remaining)
            with memoryview(buf) as view:
                dest.extend(view[:take])
            del buf[:take]
            remaining -= take
        while remaining > 0:
            more = await reader.read(min(STREAM_READER_LIMIT, remaining))
            if not more:
                raise _ProtocolRefusalError(
                    400, "Bad Request", "Invalid or incomplete chunked request body."
                )
            if len(more) <= remaining:
                dest.extend(more)
                remaining -= len(more)
            else:
                dest.extend(more[:remaining])
                buf.extend(more[remaining:])
                remaining = 0

    async def _read_exact_from(
        self, reader: asyncio.StreamReader, buf: bytearray, length: int
    ) -> bytes:
        while len(buf) < length:
            want = min(STREAM_READER_LIMIT, length - len(buf))
            more = await reader.read(want)
            if not more:
                raise _ProtocolRefusalError(
                    400, "Bad Request", "Invalid or incomplete chunked request body."
                )
            buf.extend(more)
        out = bytes(buf[:length])
        del buf[:length]
        return out

    async def _read_chunked_body(
        self,
        reader: asyncio.StreamReader,
        prebuffer: bytearray,
        reserve_bytes: Callable[[int], None],
    ) -> bytearray:
        buf = prebuffer
        decoded = bytearray()
        deadline = time.monotonic() + self.config.body_read_seconds
        try:
            async with asyncio.timeout_at(deadline):
                while True:
                    size_line = await self._read_line_from(reader, buf, MAX_CHUNK_LINE_BYTES)
                    size_token = size_line.split(b";", 1)[0]
                    if not HEX_DIGITS_RE.fullmatch(size_token):
                        raise _ProtocolRefusalError(
                            400, "Bad Request", "Invalid chunk size in request body."
                        )
                    chunk_size = int(size_token, 16)
                    if chunk_size == 0:
                        trailer_lines = 0
                        while True:
                            trailer = await self._read_line_from(reader, buf, 4096)
                            if not trailer:
                                break
                            trailer_lines += 1
                            if trailer_lines > 16:
                                raise _ProtocolRefusalError(
                                    400, "Bad Request", "Excessive chunk trailers."
                                )
                        if buf:
                            raise _ProtocolRefusalError(
                                400, "Bad Request", "Trailing bytes after chunked body."
                            )
                        return decoded
                    if len(decoded) + chunk_size > self.config.body_max_bytes:
                        raise _ProtocolRefusalError(
                            413, "Payload Too Large", "Request body exceeds 1 MiB."
                        )
                    reserve_bytes(len(decoded) + chunk_size)
                    await self._append_exact_from(reader, buf, decoded, chunk_size)
                    crlf = await self._read_exact_from(reader, buf, 2)
                    if crlf != b"\r\n":
                        raise _ProtocolRefusalError(400, "Bad Request", "Malformed chunk boundary.")
        except TimeoutError:
            decoded.clear()
            buf.clear()
            raise _ProtocolRefusalError(
                408, "Request Timeout", "Request body read deadline exceeded."
            ) from None
        except BaseException:
            decoded.clear()
            buf.clear()
            raise

    async def _forward_upstream(
        self,
        head: _ParsedRequestHead,
        body_buf: bytearray,
        client_writer: asyncio.StreamWriter,
        *,
        on_request_flushed: Callable[[], None] | None = None,
    ) -> None:
        try:
            async with asyncio.timeout(UPSTREAM_CONNECT_SECONDS):
                up_reader, up_writer = await asyncio.open_connection(
                    self.config.upstream_host,
                    self.config.upstream_port,
                    limit=STREAM_READER_LIMIT,
                )
        except (TimeoutError, OSError) as exc:
            body_buf.clear()
            if on_request_flushed is not None:
                on_request_flushed()
            raise _ProtocolRefusalError(
                503,
                "Service Unavailable",
                "Upstream API unavailable.",
                retry_after=1,
            ) from exc

        response_started = False
        try:
            body_len = len(body_buf)
            out_lines = [f"{head.method} {head.target} HTTP/1.1"]
            for name, value in head.headers:
                lower = name.lower()
                if lower in HOP_BY_HOP_HEADERS or lower == "content-length":
                    continue
                out_lines.append(f"{name}: {value}")
            if body_len or head.method in MUTATING_METHODS or head.content_length is not None:
                out_lines.append(f"Content-Length: {body_len}")
            out_lines.append("Connection: close")
            serialized_head = ("\r\n".join(out_lines) + "\r\n\r\n").encode("latin-1")

            async with asyncio.timeout(UPSTREAM_RESPONSE_SECONDS):
                up_writer.write(serialized_head)
                if body_len:
                    for offset in range(0, body_len, 65536):
                        up_writer.write(bytes(body_buf[offset : offset + 65536]))
                        await up_writer.drain()
                else:
                    await up_writer.drain()
                # Free per-request bytearray storage and global slot/byte budget immediately once flushed.
                body_buf.clear()
                if on_request_flushed is not None:
                    on_request_flushed()
                    on_request_flushed = None

                resp_buf = bytearray()
                while True:
                    idx = resp_buf.find(b"\r\n\r\n")
                    if idx != -1:
                        break
                    if len(resp_buf) > 65536:
                        raise _ProtocolRefusalError(
                            502, "Bad Gateway", "Upstream response headers oversized."
                        )
                    chunk = await up_reader.read(8192)
                    if not chunk:
                        raise _ProtocolRefusalError(
                            502, "Bad Gateway", "Upstream closed before response headers."
                        )
                    resp_buf.extend(chunk)

                raw_resp_head = bytes(resp_buf[:idx]).decode("latin-1")
                resp_remainder = bytes(resp_buf[idx + 4 :])
                resp_lines = raw_resp_head.split("\r\n")
                rewritten = [resp_lines[0]]
                for line in resp_lines[1:]:
                    hdr_name = line.partition(":")[0].strip().lower()
                    if hdr_name in {"connection", "keep-alive"}:
                        continue
                    rewritten.append(line)
                rewritten.append("Connection: close")
                response_started = True
                client_writer.write(("\r\n".join(rewritten) + "\r\n\r\n").encode("latin-1"))
                if resp_remainder:
                    client_writer.write(resp_remainder)
                await client_writer.drain()

                while True:
                    body_chunk = await up_reader.read(65536)
                    if not body_chunk:
                        break
                    client_writer.write(body_chunk)
                    await client_writer.drain()
        except TimeoutError as exc:
            raise _ProtocolRefusalError(
                504,
                "Gateway Timeout",
                "Upstream API timed out.",
                response_started=response_started,
            ) from exc
        finally:
            if on_request_flushed is not None:
                on_request_flushed()
            with contextlib.suppress(OSError, ConnectionError):
                up_writer.close()
                await up_writer.wait_closed()

    async def _graceful_close(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        self._resume_transport(writer)
        with contextlib.suppress(OSError, ConnectionError, RuntimeError):
            if writer.can_write_eof():
                writer.write_eof()
        with contextlib.suppress(TimeoutError, OSError, ConnectionError):
            async with asyncio.timeout(0.05):
                await reader.read(4096)
        with contextlib.suppress(OSError, ConnectionError):
            writer.close()
            await writer.wait_closed()

    async def _handle_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        client_sock = writer.get_extra_info("socket")
        if client_sock is not None:
            with contextlib.suppress(OSError):
                client_sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, SOCKET_RCVBUF_BYTES)
        # Pause transport reads immediately upon accept until connection capacity is verified.
        self._pause_transport(writer)

        if self._active_connections >= self.config.max_connections:
            await self._send_json(
                writer,
                503,
                "Service Unavailable",
                {"detail": "Edge connection capacity busy."},
                retry_after=1,
            )
            await self._graceful_close(reader, writer)
            return

        self._active_connections += 1
        global_slot_held = False
        reserved_body_bytes = 0

        def reserve_global_body(target_bytes: int) -> None:
            nonlocal global_slot_held, reserved_body_bytes
            needed_total = max(reserved_body_bytes, target_bytes)
            delta = needed_total - reserved_body_bytes
            if not global_slot_held:
                if (
                    self._active_body_slots >= self.config.global_body_slots
                    or self._active_body_bytes + needed_total > self.config.max_global_body_bytes
                ):
                    raise _ProtocolRefusalError(
                        503,
                        "Service Unavailable",
                        "Request body reader capacity busy.",
                        retry_after=1,
                    )
                self._active_body_slots += 1
                self._active_body_bytes += needed_total
                global_slot_held = True
                reserved_body_bytes = needed_total
                return
            if delta > 0:
                if self._active_body_bytes + delta > self.config.max_global_body_bytes:
                    raise _ProtocolRefusalError(
                        503,
                        "Service Unavailable",
                        "Request body reader capacity busy.",
                        retry_after=1,
                    )
                self._active_body_bytes += delta
                reserved_body_bytes += delta

        def release_global_slot() -> None:
            nonlocal global_slot_held, reserved_body_bytes
            if global_slot_held:
                global_slot_held = False
                self._active_body_slots -= 1
                self._active_body_bytes -= reserved_body_bytes
                reserved_body_bytes = 0

        body_buf = bytearray()
        try:
            peer_info = writer.get_extra_info("peername")
            peer_ip = str(peer_info[0]) if isinstance(peer_info, tuple) and peer_info else ""

            self._resume_transport(writer)
            parsed = await self._read_head_and_prefix(reader)
            # Pause transport immediately after header parse so un-admitted connections cannot
            # accumulate unread body bytes in StreamReader while awaiting per-IP micro-burst slots.
            self._pause_transport(writer)
            if parsed is None:
                return
            head, prebuffer = parsed

            if (
                _peer_is_loopback(peer_ip)
                and head.method == "GET"
                and head.target == "/_admission/live"
                and not head.chunked
                and head.content_length in (None, 0)
            ):
                await self._send_json(writer, 200, "OK", {"status": "alive"})
                return

            if self.config.require_trusted_edge and not _peer_in_trusted(
                peer_ip, self.config.trusted_edges
            ):
                raise _ProtocolRefusalError(
                    403, "Forbidden", "Direct peer is not an admitted edge proxy."
                )

            meta = _meta_from_headers(peer_ip, head.headers)
            resolved_client = client_address(meta, self.config.trusted_edges)
            bucket_key = normalize_client_bucket(resolved_client)

            carries_body = head.chunked or (
                head.content_length is not None and head.content_length > 0
            )
            is_write = carries_body or head.method in MUTATING_METHODS

            if not is_write:
                if prebuffer:
                    raise _ProtocolRefusalError(
                        400, "Bad Request", "Unexpected body bytes on bodyless request."
                    )
                try:
                    async with asyncio.timeout(self.config.upstream_queue_wait_seconds):
                        await self._upstream_read_sem.acquire()
                except TimeoutError:
                    raise _ProtocolRefusalError(
                        503,
                        "Service Unavailable",
                        "Upstream read lane busy.",
                        retry_after=1,
                    ) from None
                try:
                    await self._forward_upstream(head, body_buf, writer)
                finally:
                    self._upstream_read_sem.release()
                return

            if head.content_length is not None and head.content_length > self.config.body_max_bytes:
                prebuffer.clear()
                raise _ProtocolRefusalError(413, "Payload Too Large", "Request body exceeds 1 MiB.")

            retry_wait = self._rate_limiter.charge(bucket_key)
            if retry_wait is not None:
                prebuffer.clear()
                raise _ProtocolRefusalError(
                    429,
                    "Too Many Requests",
                    "Per-client write rate limit exceeded.",
                    retry_after=retry_wait,
                )

            if carries_body:
                async with self._ip_body_slots.acquire(
                    bucket_key, timeout=self.config.per_ip_queue_wait_seconds
                ):
                    # Fail-fast 503 with zero waiting queue when global slot or byte budget is full.
                    initial_target = (
                        len(prebuffer)
                        if head.chunked
                        else max(len(prebuffer), head.content_length or 0)
                    )
                    reserve_global_body(initial_target)
                    self._resume_transport(writer)
                    try:
                        if head.expect_continue:
                            writer.write(b"HTTP/1.1 100 Continue\r\n\r\n")
                            await writer.drain()

                        if head.chunked:
                            body_buf = await self._read_chunked_body(
                                reader, prebuffer, reserve_global_body
                            )
                        else:
                            if head.content_length is None:
                                raise _ProtocolRefusalError(
                                    400, "Bad Request", "Missing Content-Length."
                                )
                            body_buf = await self._read_fixed_body(
                                reader, prebuffer, head.content_length
                            )
                    finally:
                        self._pause_transport(writer)
            elif prebuffer:
                prebuffer.clear()
                raise _ProtocolRefusalError(
                    400, "Bad Request", "Unexpected body bytes on zero-length request."
                )

            try:
                async with asyncio.timeout(self.config.upstream_queue_wait_seconds):
                    await self._upstream_write_sem.acquire()
            except TimeoutError:
                raise _ProtocolRefusalError(
                    503,
                    "Service Unavailable",
                    "Upstream write lane busy.",
                    retry_after=1,
                ) from None
            try:
                await self._forward_upstream(
                    head,
                    body_buf,
                    writer,
                    on_request_flushed=release_global_slot,
                )
            finally:
                self._upstream_write_sem.release()

        except _ProtocolRefusalError as refusal:
            body_buf.clear()
            if not refusal.response_started and not writer.is_closing():
                await self._send_json(
                    writer,
                    refusal.status,
                    refusal.reason,
                    {"detail": refusal.detail},
                    retry_after=refusal.retry_after,
                )
        except (ConnectionError, OSError):
            body_buf.clear()
        finally:
            body_buf.clear()
            release_global_slot()
            self._active_connections -= 1
            await self._graceful_close(reader, writer)


def _parse_host_port(raw: str, *, allow_unspecified: bool) -> tuple[str, int]:
    host, sep, port_str = raw.rpartition(":")
    if not sep or not host or not port_str.isascii() or not port_str.isdecimal():
        raise ValueError("address must be host:port")
    port = int(port_str)
    if not 0 <= port <= 65535 or (not allow_unspecified and port == 0):
        raise ValueError("port out of range")
    return host, port


def build_config(
    argv: Sequence[str] | None = None,
    environment: Mapping[str, str] | None = None,
) -> AdmissionConfig:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", default="0.0.0.0:8080")
    parser.add_argument("--upstream", default="server:8000")
    parser.add_argument("--require-trusted-edge", action="store_true")
    parser.add_argument("--max-connections", type=int, default=DEFAULT_MAX_CONNECTIONS)
    parser.add_argument("--global-body-slots", type=int, default=DEFAULT_GLOBAL_BODY_SLOTS)
    parser.add_argument(
        "--max-global-body-bytes",
        type=int,
        default=DEFAULT_MAX_GLOBAL_BODY_BYTES,
    )
    parser.add_argument("--per-ip-body-slots", type=int, default=DEFAULT_PER_IP_BODY_SLOTS)
    parser.add_argument(
        "--per-ip-queue-wait-seconds",
        type=float,
        default=DEFAULT_PER_IP_QUEUE_WAIT_SECONDS,
    )
    parser.add_argument("--per-ip-write-rate", type=float, default=DEFAULT_PER_IP_WRITE_RATE)
    parser.add_argument("--per-ip-write-burst", type=int, default=DEFAULT_PER_IP_WRITE_BURST)
    parser.add_argument(
        "--upstream-write-concurrency",
        type=int,
        default=DEFAULT_UPSTREAM_WRITE_CONCURRENCY,
    )
    parser.add_argument(
        "--upstream-read-concurrency",
        type=int,
        default=DEFAULT_UPSTREAM_READ_CONCURRENCY,
    )
    parser.add_argument("--body-read-seconds", type=float, default=BODY_READ_SECONDS)
    args = parser.parse_args(argv)

    env = os.environ if environment is None else environment
    try:
        _refuse_unsafe(env, "kodera-edge-admission")
        edges = trusted_edge(env)
    except ImproperlyConfigured:
        parser.error("the edge admission environment is unsafe")

    if args.require_trusted_edge and not edges:
        parser.error("KODERA_TRUSTED_EDGE_ADDRESSES is required when --require-trusted-edge is set")

    try:
        listen_host, listen_port = _parse_host_port(args.bind, allow_unspecified=True)
        upstream_host, upstream_port = _parse_host_port(args.upstream, allow_unspecified=False)
    except ValueError:
        parser.error("invalid --bind or --upstream address")

    if (
        args.max_connections < 4
        or args.global_body_slots < 1
        or args.max_global_body_bytes < BODY_MAX_BYTES
        or args.per_ip_body_slots < 1
        or args.per_ip_body_slots > args.global_body_slots
        or args.per_ip_queue_wait_seconds < 0
        or args.per_ip_write_rate <= 0
        or args.per_ip_write_burst < 1
        or args.upstream_write_concurrency < 1
        or args.upstream_read_concurrency < 1
        or args.body_read_seconds <= 0
    ):
        parser.error("invalid admission capacity bounds")

    return AdmissionConfig(
        listen_host=listen_host,
        listen_port=listen_port,
        upstream_host=upstream_host,
        upstream_port=upstream_port,
        trusted_edges=edges,
        require_trusted_edge=args.require_trusted_edge,
        max_connections=args.max_connections,
        global_body_slots=args.global_body_slots,
        max_global_body_bytes=args.max_global_body_bytes,
        per_ip_body_slots=args.per_ip_body_slots,
        per_ip_queue_wait_seconds=args.per_ip_queue_wait_seconds,
        per_ip_write_rate=args.per_ip_write_rate,
        per_ip_write_burst=args.per_ip_write_burst,
        upstream_write_concurrency=args.upstream_write_concurrency,
        upstream_read_concurrency=args.upstream_read_concurrency,
        body_read_seconds=args.body_read_seconds,
    )


async def _serve(config: AdmissionConfig) -> None:
    server = EdgeAdmissionServer(config)
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, stop_event.set)
    await server.start()
    try:
        await stop_event.wait()
    finally:
        await server.close()


def main(
    argv: Sequence[str] | None = None,
    environment: Mapping[str, str] | None = None,
) -> None:
    config = build_config(argv=argv, environment=environment)
    asyncio.run(_serve(config))


if __name__ == "__main__":
    main()
