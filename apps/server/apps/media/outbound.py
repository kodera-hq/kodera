"""One-resolution public HTTP transport with pinned TCP, TLS identity and an absolute deadline."""

from __future__ import annotations

import http.client
import io
import ipaddress
import re
import socket
import ssl
import threading
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as ResolutionTimeout
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlsplit, urlunsplit

MAX_URL = 2048
MAX_ADDRESSES = 32
MAX_WIRE = 320 * 1024
BLOCKED_V4 = tuple(
    ipaddress.ip_network(value)
    for value in (
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.0.0.0/24",
        "192.0.2.0/24",
        "192.88.99.0/24",
        "192.168.0.0/16",
        "198.18.0.0/15",
        "198.51.100.0/24",
        "203.0.113.0/24",
        "224.0.0.0/4",
        "240.0.0.0/4",
    )
)
LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")
RESOLVERS = ThreadPoolExecutor(max_workers=4, thread_name_prefix="public-dns")
RESOLVER_SLOTS = threading.BoundedSemaphore(4)
TRANSITIONS = (
    ipaddress.ip_network("64:ff9b::/96"),
    ipaddress.ip_network("64:ff9b:1::/48"),
)


class BlockedTargetError(ValueError):
    def __init__(self, reason: str = "blocked-target") -> None:
        super().__init__("URL target refused")
        self.reason = reason


class FetchError(ValueError):
    def __init__(self, reason: str = "unavailable") -> None:
        super().__init__("URL fetch refused")
        self.reason = reason


def remaining(deadline: float) -> float:
    left = deadline - time.monotonic()
    if left <= 0:
        raise FetchError("timeout")
    return left


@dataclass(frozen=True)
class Target:
    url: str
    scheme: str
    host: str
    port: int
    path: str

    @property
    def authority(self) -> str:
        host = "[" + self.host + "]" if ":" in self.host else self.host
        return (
            host if self.port == (443 if self.scheme == "https" else 80) else f"{host}:{self.port}"
        )


def target(url: str, *, https_only: bool = False) -> Target:
    if (
        not isinstance(url, str)
        or not 1 <= len(url) <= MAX_URL
        or any(ord(c) <= 32 or ord(c) == 127 for c in url)
    ):
        raise BlockedTargetError()
    if "\\" in url or re.search(r"%(?![a-fA-F0-9]{2})", url):
        raise BlockedTargetError()
    try:
        parts = urlsplit(url)
        if (
            parts.scheme not in ({"https"} if https_only else {"http", "https"})
            or not parts.hostname
            or "@" in parts.netloc
        ):
            raise BlockedTargetError()
        host = parts.hostname.removesuffix(".").encode("idna").decode("ascii").lower()
        if "%" in host or len(host) > 253:
            raise BlockedTargetError()
        port = parts.port if parts.port is not None else (443 if parts.scheme == "https" else 80)
        if port not in {80, 443}:
            raise BlockedTargetError()
        try:
            ipaddress.ip_address(host)
        except ValueError:
            if "." not in host or not all(LABEL.fullmatch(label) for label in host.split(".")):
                raise BlockedTargetError() from None
        path = quote(parts.path or "/", safe="/%:@!$&'()*+,;=-._~")
        query = quote(parts.query, safe="/%?:@!$&'()*+,;=-._~")
        authority = "[" + host + "]" if ":" in host else host
        if port != (443 if parts.scheme == "https" else 80):
            authority += ":" + str(port)
        canonical = urlunsplit((parts.scheme, authority, path, query, ""))
        if len(canonical) > MAX_URL:
            raise BlockedTargetError()
        return Target(canonical, parts.scheme, host, port, path + ("?" + query if query else ""))
    except (ValueError, UnicodeError):
        raise BlockedTargetError() from None


def public_address(value: str) -> None:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        raise BlockedTargetError("private-target") from None
    if not address.is_global or address.is_multicast or address.is_reserved:
        raise BlockedTargetError("private-target")
    if isinstance(address, ipaddress.IPv4Address) and any(
        address in network for network in BLOCKED_V4
    ):
        raise BlockedTargetError("private-target")
    if isinstance(address, ipaddress.IPv6Address):
        if (
            address.is_site_local
            or address.ipv4_mapped is not None
            or address.sixtofour is not None
            or address.teredo is not None
            or any(address in network for network in TRANSITIONS)
        ):
            raise BlockedTargetError("private-target")


def addresses(destination: Target, deadline: float) -> list[tuple[Any, ...]]:
    remaining(deadline)
    try:
        literal = ipaddress.ip_address(destination.host)
    except ValueError:
        literal = None
    if literal is not None:
        public_address(destination.host)
        family = socket.AF_INET if literal.version == 4 else socket.AF_INET6
        sockaddr = (
            (str(literal), destination.port)
            if literal.version == 4
            else (str(literal), destination.port, 0, 0)
        )
        return [(family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", sockaddr)]
    if not RESOLVER_SLOTS.acquire(blocking=False):
        raise FetchError("resolver-busy")
    try:
        future = RESOLVERS.submit(
            socket.getaddrinfo,
            destination.host + ".",
            destination.port,
            0,
            socket.SOCK_STREAM,
            socket.IPPROTO_TCP,
        )
    except BaseException:
        RESOLVER_SLOTS.release()
        raise
    future.add_done_callback(lambda _: RESOLVER_SLOTS.release())
    try:
        resolved = future.result(timeout=remaining(deadline))
    except ResolutionTimeout:
        raise FetchError("timeout") from None
    except OSError:
        raise FetchError() from None
    if not resolved or len(resolved) > MAX_ADDRESSES:
        raise BlockedTargetError()
    validated: list[tuple[Any, ...]] = []
    for family, kind, protocol, _, answer in resolved:
        if (
            family not in {socket.AF_INET, socket.AF_INET6}
            or kind != socket.SOCK_STREAM
            or protocol not in {0, socket.IPPROTO_TCP}
            or not isinstance(answer, tuple)
            or len(answer) != (2 if family == socket.AF_INET else 4)
            or not isinstance(answer[0], str)
        ):
            raise BlockedTargetError()
        public_address(answer[0])
        parsed = ipaddress.ip_address(answer[0])
        if (
            parsed.version != (4 if family == socket.AF_INET else 6)
            or answer[1] != destination.port
            or len(answer) == 4
            and (answer[2] != 0 or answer[3] != 0)
        ):
            raise BlockedTargetError()
        numeric = (
            (str(parsed), destination.port)
            if family == socket.AF_INET
            else (str(parsed), destination.port, 0, 0)
        )
        validated.append((family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", numeric))
    return sorted(validated, key=lambda value: (value[0], value[4][0]))


class _DeadlineReader(io.RawIOBase):
    def __init__(self, transport: _Transport) -> None:
        super().__init__()
        self.transport = transport
        self.file = transport.sock.makefile("rb", buffering=0)

    def readable(self) -> bool:
        return True

    def readinto(self, buffer: Any) -> int:
        owner = self.transport
        owner.sock.settimeout(remaining(owner.deadline))
        size = min(len(buffer), MAX_WIRE - owner.received + 1)
        if size <= 0:
            raise FetchError("too-large")
        count = self.file.readinto(memoryview(buffer)[:size])
        if count is None:
            raise FetchError("timeout")
        owner.received += count
        if owner.received > MAX_WIRE:
            raise FetchError("too-large")
        return count

    def close(self) -> None:
        self.file.close()
        super().close()


class _Transport:
    def __init__(self, sock: Any, deadline: float) -> None:
        self.sock, self.deadline, self.received = sock, deadline, 0

    def sendall(self, data: bytes) -> None:
        self.sock.settimeout(remaining(self.deadline))
        self.sock.sendall(data)

    def makefile(self, mode: str, buffering: int | None = None) -> io.BufferedReader:
        if mode != "rb":
            raise ValueError("read-only HTTP response file required")
        return io.BufferedReader(_DeadlineReader(self))

    def close(self) -> None:
        self.sock.close()


class PinnedConnection(http.client.HTTPConnection):
    def __init__(
        self, destination: Target, resolved: list[tuple[Any, ...]], deadline: float
    ) -> None:
        super().__init__(destination.host, destination.port, timeout=remaining(deadline))
        self.destination, self.resolved, self.deadline = destination, resolved, deadline
        self._transport: _Transport | None = None

    def connect(self) -> None:
        # Numeric sockaddr only: socket.connect never receives the original DNS name.
        for family, kind, protocol, _, sockaddr in self.resolved:
            raw = socket.socket(family, kind, protocol)
            try:
                raw.settimeout(remaining(self.deadline))
                raw.connect(sockaddr)
                if self.destination.scheme == "https":
                    context = ssl.create_default_context()
                    context.set_alpn_protocols(["http/1.1"])
                    raw.settimeout(remaining(self.deadline))
                    raw = context.wrap_socket(raw, server_hostname=self.destination.host)
                remaining(self.deadline)
                self._transport = _Transport(raw, self.deadline)
                self.sock = self._transport  # Documented HTTP socket adapter.
                return
            except (OSError, ssl.SSLError):
                raw.close()
                remaining(self.deadline)
        raise FetchError()


def request(
    destination: Target,
    *,
    deadline: float,
    method: str = "GET",
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[PinnedConnection, http.client.HTTPResponse]:
    resolved = addresses(destination, deadline)
    connection = PinnedConnection(destination, resolved, deadline)
    try:
        connection.request(
            method,
            destination.path,
            body=body,
            headers={
                "Host": destination.authority,
                "Connection": "close",
                "Accept-Encoding": "identity",
                **(headers or {}),
            },
        )
        return connection, connection.getresponse()
    except BaseException:
        connection.close()
        raise
