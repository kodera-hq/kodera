"""One-resolution public HTTP transport with pinned TCP, TLS identity and an absolute deadline."""

from __future__ import annotations

import http.client
import io
import ipaddress
import re
import secrets
import socket
import ssl
import struct
import threading
import time
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit, urlunsplit

MAX_URL = 2048
MAX_ADDRESSES = 32
MAX_WIRE = 320 * 1024
MAX_DNS_PACKET = 4096
MAX_CNAME_HOPS = 4
RESOLV_CONF = Path("/etc/resolv.conf")
FALLBACK_NAMESERVERS: tuple[tuple[str, int], ...] = (("1.1.1.1", 53), ("9.9.9.9", 53))
_SYSTEM_GETADDRINFO = socket.getaddrinfo

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


class PreSendFetchError(FetchError):
    """DNS, concurrency-gate, TCP connect or TLS handshake failure before sending any HTTP byte."""


# One whole request-side outbound operation per process, including DNS and body reads.
# Resolver slots alone end before the HTTP response body is consumed.
_REQUEST_LANE = threading.BoundedSemaphore(1)


@contextmanager
def request_lane() -> Iterator[None]:
    if not _REQUEST_LANE.acquire(blocking=False):
        raise FetchError("resolver-busy")
    try:
        yield
    finally:
        _REQUEST_LANE.release()


class _ResolverPool:
    """Isolated concurrency gate per transport lane with optional per-principal/org fairness."""

    def __init__(self, *, max_slots: int, per_scope_slots: int) -> None:
        self._max_slots = max_slots
        self._per_scope_slots = per_scope_slots
        self._lock = threading.Lock()
        self._active = 0
        self._by_scope: dict[str, int] = {}

    @contextmanager
    def acquire(self, scope_key: str | None = None) -> Iterator[None]:
        with self._lock:
            if self._active >= self._max_slots:
                raise PreSendFetchError("resolver-busy")
            if scope_key is not None and self._by_scope.get(scope_key, 0) >= self._per_scope_slots:
                raise PreSendFetchError("resolver-busy")
            self._active += 1
            if scope_key is not None:
                self._by_scope[scope_key] = self._by_scope.get(scope_key, 0) + 1
        try:
            yield
        finally:
            with self._lock:
                self._active -= 1
                if scope_key is not None:
                    remaining_scope = self._by_scope.get(scope_key, 1) - 1
                    if remaining_scope <= 0:
                        self._by_scope.pop(scope_key, None)
                    else:
                        self._by_scope[scope_key] = remaining_scope


RESOLVER_POOLS: dict[str, _ResolverPool] = {
    "default": _ResolverPool(max_slots=8, per_scope_slots=4),
    "unfurl": _ResolverPool(max_slots=4, per_scope_slots=2),
    "webhook": _ResolverPool(max_slots=8, per_scope_slots=4),
    "push": _ResolverPool(max_slots=8, per_scope_slots=4),
    "storage": _ResolverPool(max_slots=16, per_scope_slots=8),
}

_resolv_lock = threading.Lock()
_resolv_cache: tuple[float, tuple[tuple[str, int], ...]] | None = None


def remaining(deadline: float, *, pre_send: bool = False) -> float:
    left = deadline - time.monotonic()
    if left <= 0:
        raise PreSendFetchError("timeout") if pre_send else FetchError("timeout")
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


def _configured_nameservers() -> tuple[tuple[str, int], ...]:
    global _resolv_cache
    try:
        mtime = RESOLV_CONF.stat().st_mtime
    except OSError:
        return FALLBACK_NAMESERVERS
    with _resolv_lock:
        if _resolv_cache is not None and _resolv_cache[0] == mtime:
            return _resolv_cache[1]
    servers: list[tuple[str, int]] = []
    try:
        lines = RESOLV_CONF.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return FALLBACK_NAMESERVERS
    for raw_line in lines:
        line = raw_line.split("#", 1)[0].split(";", 1)[0].strip()
        parts = line.split()
        if len(parts) >= 2 and parts[0].lower() == "nameserver":
            candidate = parts[1].split("%", 1)[0]
            try:
                ipaddress.ip_address(candidate)
            except ValueError:
                continue
            servers.append((candidate, 53))
            if len(servers) >= 3:
                break
    resolved = tuple(servers) if servers else FALLBACK_NAMESERVERS
    with _resolv_lock:
        _resolv_cache = (mtime, resolved)
    return resolved


def _encode_dns_name(host: str) -> bytes:
    labels = [part for part in host.removesuffix(".").split(".") if part]
    if not labels:
        raise PreSendFetchError()
    encoded = bytearray()
    for label in labels:
        raw = label.encode("ascii")
        if not 1 <= len(raw) <= 63:
            raise PreSendFetchError()
        encoded.append(len(raw))
        encoded.extend(raw)
    encoded.append(0)
    return bytes(encoded)


def _decode_dns_name(packet: bytes, offset: int) -> tuple[str, int]:
    labels: list[str] = []
    pos = offset
    next_offset: int | None = None
    visited: set[int] = set()
    total_len = 0
    while True:
        if pos >= len(packet):
            raise ValueError("truncated DNS name")
        length = packet[pos]
        if length == 0:
            pos += 1
            break
        if (length & 0xC0) == 0xC0:
            if pos + 1 >= len(packet):
                raise ValueError("truncated DNS pointer")
            pointer = ((length & 0x3F) << 8) | packet[pos + 1]
            if pointer in visited or pointer >= len(packet):
                raise ValueError("invalid DNS compression pointer")
            visited.add(pointer)
            if next_offset is None:
                next_offset = pos + 2
            pos = pointer
            continue
        if length & 0xC0:
            raise ValueError("unsupported DNS label type")
        pos += 1
        if pos + length > len(packet):
            raise ValueError("truncated DNS label")
        label = packet[pos : pos + length].decode("ascii").lower()
        total_len += len(label) + 1
        if total_len > 255:
            raise ValueError("DNS name exceeds maximum length")
        labels.append(label)
        pos += length
    return ".".join(labels), (pos if next_offset is None else next_offset)


def _exchange_dns_udp(ns_ip: str, ns_port: int, query: bytes, timeout: float) -> tuple[bytes, bool]:
    parsed = ipaddress.ip_address(ns_ip)
    family = socket.AF_INET if parsed.version == 4 else socket.AF_INET6
    sockaddr = (ns_ip, ns_port) if parsed.version == 4 else (ns_ip, ns_port, 0, 0)
    sock = socket.socket(family, socket.SOCK_DGRAM)
    try:
        sock.settimeout(timeout)
        sock.sendto(query, sockaddr)
        reply, sender = sock.recvfrom(MAX_DNS_PACKET)
        if sender[0] != ns_ip and ipaddress.ip_address(sender[0]) != parsed:
            raise ValueError("unexpected DNS responder")
        truncated = len(reply) >= 4 and bool(struct.unpack("!H", reply[2:4])[0] & 0x0200)
        return reply, truncated
    finally:
        sock.close()


def _exchange_dns_tcp(ns_ip: str, ns_port: int, query: bytes, deadline: float) -> bytes:
    parsed = ipaddress.ip_address(ns_ip)
    family = socket.AF_INET if parsed.version == 4 else socket.AF_INET6
    sockaddr = (ns_ip, ns_port) if parsed.version == 4 else (ns_ip, ns_port, 0, 0)
    sock = socket.socket(family, socket.SOCK_STREAM)
    try:
        sock.settimeout(remaining(deadline, pre_send=True))
        sock.connect(sockaddr)
        framed = struct.pack("!H", len(query)) + query
        sock.settimeout(remaining(deadline, pre_send=True))
        sock.sendall(framed)
        header = bytearray()
        while len(header) < 2:
            sock.settimeout(remaining(deadline, pre_send=True))
            chunk = sock.recv(2 - len(header))
            if not chunk:
                raise ValueError("truncated TCP DNS length")
            header.extend(chunk)
        (size,) = struct.unpack("!H", bytes(header))
        if not 12 <= size <= MAX_DNS_PACKET * 4:
            raise ValueError("invalid TCP DNS size")
        payload = bytearray()
        while len(payload) < size:
            sock.settimeout(remaining(deadline, pre_send=True))
            chunk = sock.recv(size - len(payload))
            if not chunk:
                raise ValueError("truncated TCP DNS payload")
            payload.extend(chunk)
        return bytes(payload)
    finally:
        sock.close()


def _parse_dns_response(
    packet: bytes, txid: int, qname: str, qtype: int
) -> tuple[int, list[str], list[str]]:
    if len(packet) < 12:
        raise ValueError("short DNS header")
    resp_id, flags, qdcount, ancount, nscount, arcount = struct.unpack("!HHHHHH", packet[:12])
    if resp_id != txid or not (flags & 0x8000):
        raise ValueError("mismatched DNS response")
    rcode = flags & 0x000F
    if qdcount != 1:
        raise ValueError("unexpected DNS question count")
    echoed_name, offset = _decode_dns_name(packet, 12)
    if offset + 4 > len(packet):
        raise ValueError("truncated DNS question")
    echoed_type, echoed_class = struct.unpack("!HH", packet[offset : offset + 4])
    offset += 4
    if echoed_name != qname.removesuffix(".").lower() or echoed_type != qtype or echoed_class != 1:
        raise ValueError("mismatched DNS question")

    ips: list[str] = []
    cnames: list[str] = []
    cnames_map: dict[str, str] = {}
    for _ in range(ancount):
        owner, offset = _decode_dns_name(packet, offset)
        if offset + 10 > len(packet):
            raise ValueError("truncated DNS RR header")
        rtype, rclass, _ttl, rdlength = struct.unpack("!HHIH", packet[offset : offset + 10])
        offset += 10
        if offset + rdlength > len(packet):
            raise ValueError("truncated DNS rdata")
        rdata = packet[offset : offset + rdlength]
        if rclass == 1:
            if rtype == 1 and qtype == 1 and rdlength == 4:
                ips.append(str(ipaddress.IPv4Address(rdata)))
            elif rtype == 28 and qtype == 28 and rdlength == 16:
                ips.append(str(ipaddress.IPv6Address(rdata)))
            elif rtype == 5:
                cname_target, _ = _decode_dns_name(packet, offset)
                cnames_map[owner] = cname_target
                cnames.append(cname_target)
        offset += rdlength

    # Skip authority and additional sections strictly to detect malformed packets.
    for _ in range(nscount + arcount):
        if offset >= len(packet):
            break
        _, offset = _decode_dns_name(packet, offset)
        if offset + 10 > len(packet):
            break
        (_rtype, _rclass, _ttl, rdlength) = struct.unpack("!HHIH", packet[offset : offset + 10])
        offset += 10 + rdlength

    current = qname.removesuffix(".").lower()
    terminal_cnames: list[str] = []
    for _ in range(MAX_CNAME_HOPS):
        nxt = cnames_map.get(current)
        if nxt is None:
            break
        current = nxt
        terminal_cnames = [current]
    return rcode, ips, (terminal_cnames or cnames[:1])


def _query_qtype(
    host: str,
    qtype: int,
    deadline: float,
    nameservers: Sequence[tuple[str, int]],
) -> list[str]:
    current_host = host.removesuffix(".").lower()
    for _hop in range(MAX_CNAME_HOPS + 1):
        txid = secrets.randbits(16)
        query = (
            struct.pack("!HHHHHH", txid, 0x0100, 1, 0, 0, 0)
            + _encode_dns_name(current_host)
            + struct.pack("!HH", qtype, 1)
        )
        saw_timeout = False
        saw_error = False
        next_cname: str | None = None
        count_ns = max(1, len(nameservers))
        for index, (ns_ip, ns_port) in enumerate(nameservers):
            left = remaining(deadline, pre_send=True)
            remaining_servers = count_ns - index
            per_server = max(0.05, left / remaining_servers) if remaining_servers > 1 else left
            try:
                packet, truncated = _exchange_dns_udp(ns_ip, ns_port, query, min(left, per_server))
                if truncated:
                    packet = _exchange_dns_tcp(ns_ip, ns_port, query, deadline)
                rcode, ips, cnames = _parse_dns_response(packet, txid, current_host, qtype)
            except TimeoutError:
                saw_timeout = True
                continue
            except (OSError, ValueError):
                saw_error = True
                continue
            if rcode == 3:
                return []
            if rcode != 0:
                saw_error = True
                continue
            if ips:
                return ips
            if cnames:
                next_cname = cnames[0]
                break
            return []
        if next_cname is not None:
            if "." not in next_cname or not all(
                LABEL.fullmatch(lbl) for lbl in next_cname.split(".")
            ):
                raise BlockedTargetError()
            current_host = next_cname
            continue
        if saw_timeout:
            raise PreSendFetchError("timeout")
        if saw_error:
            raise PreSendFetchError()
        return []
    raise PreSendFetchError()


def _resolve_stub(
    host: str,
    port: int,
    deadline: float,
    nameservers: Sequence[tuple[str, int]],
) -> list[tuple[Any, ...]]:
    results: list[tuple[Any, ...]] = []
    errors: list[PreSendFetchError] = []
    for qtype, family in ((1, socket.AF_INET), (28, socket.AF_INET6)):
        try:
            ips = _query_qtype(host, qtype, deadline, nameservers)
        except PreSendFetchError as failure:
            if results:
                break
            errors.append(failure)
            if failure.reason == "timeout" and deadline <= time.monotonic():
                break
            continue
        for ip_text in ips:
            sockaddr = (ip_text, port) if family == socket.AF_INET else (ip_text, port, 0, 0)
            results.append((family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", sockaddr))
    if not results and errors:
        for err in errors:
            if err.reason == "timeout":
                raise err
        raise errors[0]
    return results


def addresses(
    destination: Target,
    deadline: float,
    *,
    pool: str = "default",
    scope_key: str | None = None,
    nameservers: Sequence[tuple[str, int]] | None = None,
) -> list[tuple[Any, ...]]:
    remaining(deadline, pre_send=True)
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

    selected_pool = RESOLVER_POOLS.get(pool, RESOLVER_POOLS["default"])
    with selected_pool.acquire(scope_key):
        remaining(deadline, pre_send=True)
        if nameservers is None and socket.getaddrinfo is not _SYSTEM_GETADDRINFO:
            try:
                resolved = socket.getaddrinfo(
                    destination.host + ".",
                    destination.port,
                    0,
                    socket.SOCK_STREAM,
                    socket.IPPROTO_TCP,
                )
            except TimeoutError:
                raise PreSendFetchError("timeout") from None
            except OSError:
                raise PreSendFetchError() from None
        else:
            resolved = _resolve_stub(
                destination.host,
                destination.port,
                deadline,
                tuple(nameservers) if nameservers is not None else _configured_nameservers(),
            )

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
    return sorted({value for value in validated}, key=lambda value: (value[0], value[4][0]))


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
        self.transmitted = False

    def sendall(self, data: bytes) -> None:
        self.sock.settimeout(remaining(self.deadline, pre_send=not self.transmitted))
        self.transmitted = True
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
        super().__init__(
            destination.host, destination.port, timeout=remaining(deadline, pre_send=True)
        )
        self.destination, self.resolved, self.deadline = destination, resolved, deadline
        self._transport: _Transport | None = None

    @property
    def transmitted(self) -> bool:
        return bool(self._transport is not None and self._transport.transmitted)

    def connect(self) -> None:
        # Numeric sockaddr only: socket.connect never receives the original DNS name.
        saw_timeout = False
        for family, kind, protocol, _, sockaddr in self.resolved:
            raw = socket.socket(family, kind, protocol)
            try:
                raw.settimeout(remaining(self.deadline, pre_send=True))
                raw.connect(sockaddr)
                if self.destination.scheme == "https":
                    context = ssl.create_default_context()
                    context.minimum_version = ssl.TLSVersion.TLSv1_2
                    context.set_alpn_protocols(["http/1.1"])
                    raw.settimeout(remaining(self.deadline, pre_send=True))
                    raw = context.wrap_socket(raw, server_hostname=self.destination.host)
                remaining(self.deadline, pre_send=True)
                self._transport = _Transport(raw, self.deadline)
                self.sock = self._transport  # Documented HTTP socket adapter.
                return
            except TimeoutError:
                saw_timeout = True
                raw.close()
                remaining(self.deadline, pre_send=True)
            except (OSError, ssl.SSLError):
                raw.close()
                remaining(self.deadline, pre_send=True)
        raise PreSendFetchError("timeout" if saw_timeout else "unavailable")


def request(
    destination: Target,
    *,
    deadline: float,
    method: str = "GET",
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
    pool: str = "default",
    scope_key: str | None = None,
    nameservers: Sequence[tuple[str, int]] | None = None,
) -> tuple[PinnedConnection, http.client.HTTPResponse]:
    resolved = addresses(
        destination,
        deadline,
        pool=pool,
        scope_key=scope_key,
        nameservers=nameservers,
    )
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
    except PreSendFetchError:
        connection.close()
        raise
    except FetchError:
        connection.close()
        raise
    except TimeoutError:
        connection.close()
        if not connection.transmitted:
            raise PreSendFetchError("timeout") from None
        raise FetchError("timeout") from None
    except (OSError, ssl.SSLError, http.client.HTTPException):
        connection.close()
        if not connection.transmitted:
            raise PreSendFetchError() from None
        raise FetchError() from None
    except BaseException:
        connection.close()
        raise
