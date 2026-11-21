"""Bounded pure-Python RFC 1035 UDP/TCP DNS TXT resolver (`ee/saml/dns_txt.py`).

Resolves `_kodera-challenge.<domain>` DNS TXT ownership records against configured IP-literal
nameservers (`KODERA_SAML_DNS_NAMESERVERS` or `/etc/resolv.conf`) with:
- Strict 2.0-second total wall-clock deadline across all nameserver attempts (`BUG-0061`).
- CSPRNG 16-bit transaction ID + question matching (`QTYPE=TXT`, `QCLASS=IN`).
- Automatic TCP retry when UDP sets `TC=1` (`flags & 0x0200`).
- Compression-pointer loop prevention (backward-only pointers, max 16 hops).
- IP-literal-only nameserver sockets so DNS queries never trigger recursive `getaddrinfo` lookups.

Governed by `ee/LICENSE` (`LicenseRef-Kodera-EE`).
"""

from __future__ import annotations

import ipaddress
import os
import secrets
import socket
import struct
import time
from collections.abc import Sequence
from pathlib import Path

DNS_CLASS_IN = 1
DNS_TYPE_CNAME = 5
DNS_TYPE_TXT = 16
DEFAULT_DNS_PORT = 53
DEFAULT_DNS_TIMEOUT_S = 2.0
MAX_NAMESERVERS = 3
MAX_POINTER_HOPS = 16
MAX_TXT_RECORDS = 32
MAX_TXT_VALUE_LEN = 1024


def _parse_nameserver_entry(raw: str) -> tuple[str, int] | None:
    cleaned = raw.strip()
    if not cleaned:
        return None
    host_part = cleaned
    port = DEFAULT_DNS_PORT

    if cleaned.startswith("["):
        bracket_end = cleaned.find("]")
        if bracket_end <= 1:
            return None
        host_part = cleaned[1:bracket_end]
        rest = cleaned[bracket_end + 1 :]
        if rest:
            if not rest.startswith(":") or not rest[1:].isdecimal():
                return None
            port = int(rest[1:])
    elif cleaned.count(":") == 1:
        maybe_host, maybe_port = cleaned.rsplit(":", 1)
        if maybe_port.isdecimal():
            host_part = maybe_host
            port = int(maybe_port)

    if not (1 <= port <= 65535):
        return None
    try:
        addr = ipaddress.ip_address(host_part)
    except ValueError:
        return None
    return (str(addr), port)


def configured_dns_nameservers(
    *,
    raw_override: str | None = None,
    resolv_conf_path: Path = Path("/etc/resolv.conf"),
) -> tuple[tuple[str, int], ...]:
    """Resolve IP-literal `(host, port)` nameservers from env/settings or `/etc/resolv.conf`."""
    override = raw_override
    if override is None:
        try:
            from django.conf import settings

            if settings.configured:
                cfg_val = getattr(settings, "KODERA_SAML_DNS_NAMESERVERS", None)
                if isinstance(cfg_val, str) and cfg_val.strip():
                    override = cfg_val
        except ImportError:
            override = None
    if override is None:
        env_val = os.environ.get("KODERA_SAML_DNS_NAMESERVERS", "")
        if env_val.strip():
            override = env_val

    parsed: list[tuple[str, int]] = []
    if override is not None:
        for item in override.replace(";", ",").split(","):
            entry = _parse_nameserver_entry(item)
            if entry is not None and entry not in parsed:
                parsed.append(entry)
                if len(parsed) >= MAX_NAMESERVERS:
                    break
        return tuple(parsed)

    try:
        lines = resolv_conf_path.read_text(encoding="utf-8", errors="ignore").splitlines()
    except OSError:
        return ()

    for line in lines:
        stripped = line.split("#", 1)[0].split(";", 1)[0].strip()
        if not stripped:
            continue
        parts = stripped.split()
        if len(parts) >= 2 and parts[0].lower() == "nameserver":
            entry = _parse_nameserver_entry(parts[1])
            if entry is not None and entry not in parsed:
                parsed.append(entry)
                if len(parsed) >= MAX_NAMESERVERS:
                    break
    return tuple(parsed)


def _encode_dns_qname(fqdn: str) -> bytes:
    cleaned = fqdn.strip().rstrip(".").lower()
    if not cleaned or len(cleaned) > 253:
        raise ValueError("Invalid DNS query name")
    out = bytearray()
    for label in cleaned.split("."):
        if not (1 <= len(label) <= 63) or not label.isascii():
            raise ValueError("Invalid DNS label")
        label_bytes = label.encode("ascii")
        out.append(len(label_bytes))
        out.extend(label_bytes)
    out.append(0)
    if len(out) > 255:
        raise ValueError("Encoded DNS name exceeds 255 octets")
    return bytes(out)


def build_dns_txt_query(fqdn: str, *, tx_id: int | None = None) -> tuple[int, bytes]:
    """Construct an RFC 1035 standard recursive `IN TXT` query packet."""
    qname = _encode_dns_qname(fqdn)
    query_id = secrets.randbits(16) if tx_id is None else (tx_id & 0xFFFF)
    header = struct.pack("!HHHHHH", query_id, 0x0100, 1, 0, 0, 0)
    question = qname + struct.pack("!HH", DNS_TYPE_TXT, DNS_CLASS_IN)
    return query_id, header + question


def _read_dns_name(packet: bytes, offset: int) -> tuple[str, int]:
    labels: list[str] = []
    pos = offset
    next_offset: int | None = None
    hops = 0
    total_len = 0
    pkt_len = len(packet)

    while True:
        if pos >= pkt_len:
            raise ValueError("Truncated DNS name")
        length = packet[pos]
        if length == 0:
            if next_offset is None:
                next_offset = pos + 1
            break
        if (length & 0xC0) == 0xC0:
            if pos + 1 >= pkt_len:
                raise ValueError("Truncated DNS compression pointer")
            ptr = ((length & 0x3F) << 8) | packet[pos + 1]
            if ptr >= pos:
                raise ValueError("Invalid forward or self-referential DNS pointer")
            hops += 1
            if hops > MAX_POINTER_HOPS:
                raise ValueError("DNS compression pointer hop limit exceeded")
            if next_offset is None:
                next_offset = pos + 2
            pos = ptr
            continue
        if (length & 0xC0) != 0 or length > 63:
            raise ValueError("Invalid DNS label length")
        pos += 1
        if pos + length > pkt_len:
            raise ValueError("Truncated DNS label")
        label = packet[pos : pos + length].decode("ascii").lower()
        labels.append(label)
        total_len += length + 1
        if total_len > 255:
            raise ValueError("Decoded DNS name exceeds 255 octets")
        pos += length

    if next_offset is None:
        raise ValueError("Unterminated DNS name")
    return ".".join(labels), next_offset


def parse_dns_txt_response(
    packet: bytes,
    *,
    expected_tx_id: int,
    expected_fqdn: str,
) -> tuple[bool, bool, tuple[str, ...]]:
    """Parse DNS response; returns `(authoritative_done, truncated_tc, txt_records)`."""
    if len(packet) < 12 or len(packet) > 65535:
        raise ValueError("Malformed DNS packet length")

    rx_id, flags, qdcount, ancount, _nscount, _arcount = struct.unpack_from("!HHHHHH", packet, 0)
    if rx_id != expected_tx_id:
        raise ValueError("DNS transaction ID mismatch")
    if (flags & 0x8000) == 0:
        raise ValueError("DNS QR response bit not set")

    truncated = bool(flags & 0x0200)
    rcode = flags & 0x000F
    if truncated:
        return False, True, ()
    # RCODE 2 (SERVFAIL) / 5 (REFUSED): allow trying next nameserver.
    if rcode in {2, 5}:
        return False, False, ()
    # RCODE 3 (NXDOMAIN) or other terminal non-zero RCODE: authoritative empty result.
    if rcode != 0:
        return True, False, ()

    if qdcount != 1 or ancount > 64:
        raise ValueError("Unexpected DNS question or answer count")

    norm_expected = expected_fqdn.strip().rstrip(".").lower()
    qname, offset = _read_dns_name(packet, 12)
    if offset + 4 > len(packet):
        raise ValueError("Truncated DNS question")
    qtype, qclass = struct.unpack_from("!HH", packet, offset)
    offset += 4
    if qname != norm_expected or qtype != DNS_TYPE_TXT or qclass != DNS_CLASS_IN:
        raise ValueError("DNS question echo mismatch")

    accepted_owners: set[str] = {norm_expected}
    records: list[str] = []

    for _ in range(ancount):
        owner, offset = _read_dns_name(packet, offset)
        if offset + 10 > len(packet):
            raise ValueError("Truncated DNS RR header")
        rtype, rclass, _ttl, rdlength = struct.unpack_from("!HHIH", packet, offset)
        offset += 10
        rdata_end = offset + rdlength
        if rdata_end > len(packet):
            raise ValueError("Truncated DNS RR rdata")

        if rclass == DNS_CLASS_IN and owner in accepted_owners:
            if rtype == DNS_TYPE_CNAME:
                cname_target, cname_end = _read_dns_name(packet, offset)
                if cname_end == rdata_end and cname_target:
                    accepted_owners.add(cname_target)
            elif rtype == DNS_TYPE_TXT:
                pos = offset
                chunks: list[bytes] = []
                valid_txt = True
                while pos < rdata_end:
                    seg_len = packet[pos]
                    pos += 1
                    if pos + seg_len > rdata_end:
                        valid_txt = False
                        break
                    chunks.append(packet[pos : pos + seg_len])
                    pos += seg_len
                if valid_txt and chunks:
                    try:
                        decoded = b"".join(chunks).decode("utf-8").strip()
                    except UnicodeDecodeError:
                        decoded = ""
                    if decoded and len(decoded) <= MAX_TXT_VALUE_LEN:
                        records.append(decoded)
                        if len(records) >= MAX_TXT_RECORDS:
                            break
        offset = rdata_end

    return True, False, tuple(records)


def _query_udp_once(
    ns_ip: str,
    ns_port: int,
    query: bytes,
    *,
    timeout: float,
) -> bytes:
    addr_obj = ipaddress.ip_address(ns_ip)
    family = socket.AF_INET6 if addr_obj.version == 6 else socket.AF_INET
    with socket.socket(family, socket.SOCK_DGRAM) as sock:
        sock.settimeout(timeout)
        sock.sendto(query, (ns_ip, ns_port))
        data, peer = sock.recvfrom(4096)
        peer_ip = ipaddress.ip_address(peer[0].split("%", 1)[0])
        if peer_ip != addr_obj or int(peer[1]) != ns_port:
            raise ValueError("Unexpected UDP DNS responder peer")
        return data


def _query_tcp_once(
    ns_ip: str,
    ns_port: int,
    query: bytes,
    *,
    timeout: float,
    deadline: float,
) -> bytes:
    addr_obj = ipaddress.ip_address(ns_ip)
    family = socket.AF_INET6 if addr_obj.version == 6 else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        sock.connect((ns_ip, ns_port))
        framed = struct.pack("!H", len(query)) + query
        sock.sendall(framed)

        len_buf = bytearray()
        while len(len_buf) < 2:
            rem = deadline - time.monotonic()
            if rem <= 0:
                raise TimeoutError("DNS TCP length read timed out")
            sock.settimeout(rem)
            chunk = sock.recv(2 - len(len_buf))
            if not chunk:
                raise ValueError("EOF reading DNS TCP length")
            len_buf.extend(chunk)

        (resp_len,) = struct.unpack("!H", bytes(len_buf))
        if resp_len < 12:
            raise ValueError("DNS TCP response too short")

        body = bytearray()
        while len(body) < resp_len:
            rem = deadline - time.monotonic()
            if rem <= 0:
                raise TimeoutError("DNS TCP body read timed out")
            sock.settimeout(rem)
            chunk = sock.recv(min(4096, resp_len - len(body)))
            if not chunk:
                raise ValueError("EOF reading DNS TCP payload")
            body.extend(chunk)
        return bytes(body)


def query_dns_txt_records(
    fqdn: str,
    *,
    nameservers: Sequence[tuple[str, int]] | None = None,
    timeout_seconds: float = DEFAULT_DNS_TIMEOUT_S,
) -> tuple[str, ...]:
    """Query `IN TXT` records over UDP with automatic TCP fallback on `TC=1` within `2.0s`."""
    try:
        tx_id, query = build_dns_txt_query(fqdn)
    except ValueError:
        return ()

    servers = tuple(nameservers) if nameservers is not None else configured_dns_nameservers()
    if not servers:
        return ()

    effective_budget = max(0.1, min(timeout_seconds, 5.0))
    deadline = time.monotonic() + effective_budget

    for idx, (ns_ip, ns_port) in enumerate(servers):
        remaining = deadline - time.monotonic()
        if remaining <= 0.02:
            break
        slots_left = max(1, len(servers) - idx)
        attempt_timeout = max(0.05, min(remaining, remaining / slots_left))

        try:
            udp_pkt = _query_udp_once(ns_ip, ns_port, query, timeout=attempt_timeout)
            done, truncated, records = parse_dns_txt_response(
                udp_pkt,
                expected_tx_id=tx_id,
                expected_fqdn=fqdn,
            )
            if truncated:
                tcp_rem = deadline - time.monotonic()
                if tcp_rem <= 0.02:
                    break
                tcp_tx_id, tcp_query = build_dns_txt_query(fqdn)
                tcp_pkt = _query_tcp_once(
                    ns_ip,
                    ns_port,
                    tcp_query,
                    timeout=tcp_rem,
                    deadline=deadline,
                )
                done, tcp_trunc, records = parse_dns_txt_response(
                    tcp_pkt,
                    expected_tx_id=tcp_tx_id,
                    expected_fqdn=fqdn,
                )
                if not tcp_trunc and done:
                    return records
                continue
            if done:
                return records
        except (OSError, ValueError):
            continue

    return ()
