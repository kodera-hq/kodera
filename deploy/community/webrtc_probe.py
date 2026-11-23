#!/usr/bin/env python3
"""Headless WebRTC RFC 5389 STUN and RFC 5766 TURN UDP diagnostic probe.

Executes bounded (< 2.5 s default budget), dependency-free UDP diagnostics for
self-hosted Kodera deployments:
  1. RFC 5389 STUN Binding Request/Response (0x0001 / 0x0101) with 12-byte
     cryptographic transaction IDs, SASLprep (RFC 4013) credential preparation,
     optional short-term USERNAME + HMAC-SHA1 MESSAGE-INTEGRITY + CRC-32
     FINGERPRINT, post-MESSAGE-INTEGRITY attribute filtering, bounded DNS and
     RTO retransmission, and IPv4/IPv6 XOR-MAPPED-ADDRESS decoding.
  2. RFC 5766 TURN UDP Allocation & Loopback Relay Verification:
     unauthenticated Allocate (0x0003) -> 401 REALM + NONCE -> long-term MD5
     authenticated Allocate -> XOR-RELAYED-ADDRESS + XOR-MAPPED-ADDRESS ->
     CreatePermission (0x0008) -> Send Indication (0x0016) with 16-byte random
     loopback token -> Data Indication (0x0017) verification -> reliable
     Refresh(lifetime=0) (0x0004) deallocation (handling 438 stale nonce retry,
     437 allocation mismatch, and LIFETIME=0 confirmation).
  3. Evidence-backed network classification into `ok`, `turn_relay_verified`,
     `hairpin_nat_blocked`, `relay_loopback_blocked`, or
     `udp_unreachable_or_filtered` with actionable operator remediation.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import hmac
import ipaddress
import json
import math
import os
import queue
import re
import secrets
import selectors
import socket
import stat
import stringprep
import struct
import sys
import threading
import time
import unicodedata
import zlib
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Self
from urllib.parse import parse_qs, urlsplit

STUN_MAGIC_COOKIE = 0x2112A442
STUN_FINGERPRINT_XOR = 0x5354554E
STUN_HEADER_STRUCT = struct.Struct(">HHI12s")
STUN_ATTR_HEADER_STRUCT = struct.Struct(">HH")

MSG_BINDING_REQUEST = 0x0001
MSG_BINDING_SUCCESS = 0x0101
MSG_BINDING_ERROR = 0x0111

MSG_ALLOCATE_REQUEST = 0x0003
MSG_ALLOCATE_SUCCESS = 0x0103
MSG_ALLOCATE_ERROR = 0x0113

MSG_REFRESH_REQUEST = 0x0004
MSG_REFRESH_SUCCESS = 0x0104
MSG_REFRESH_ERROR = 0x0114

MSG_CREATE_PERMISSION_REQUEST = 0x0008
MSG_CREATE_PERMISSION_SUCCESS = 0x0108
MSG_CREATE_PERMISSION_ERROR = 0x0118

MSG_SEND_INDICATION = 0x0016
MSG_DATA_INDICATION = 0x0017

ATTR_MAPPED_ADDRESS = 0x0001
ATTR_USERNAME = 0x0006
ATTR_MESSAGE_INTEGRITY = 0x0008
ATTR_ERROR_CODE = 0x0009
ATTR_LIFETIME = 0x000D
ATTR_XOR_PEER_ADDRESS = 0x0012
ATTR_DATA = 0x0013
ATTR_REALM = 0x0014
ATTR_NONCE = 0x0015
ATTR_XOR_RELAYED_ADDRESS = 0x0016
ATTR_REQUESTED_TRANSPORT = 0x0019
ATTR_XOR_MAPPED_ADDRESS = 0x0020
ATTR_FINGERPRINT = 0x8028

TRANSPORT_UDP = 17
DEFAULT_BUDGET_SECONDS = 2.0
MAX_DEFAULT_BUDGET_SECONDS = 2.5
DEFAULT_STUN_PORT = 3478
DEFAULT_TURN_PORT = 3478
DEFAULT_PORT_START = 50000
DEFAULT_PORT_END = 50200
DEFAULT_MAX_PORT_SAMPLES = 3

ENV_LINE_RE = re.compile(r"^([A-Z][A-Z0-9_]*)=(.*)$")
SECRET_KEY_NAME_RE = re.compile(
    r"(?:^|_)(?:API)?KEYS?(?:_|$)|APIKEY|SECRET|PASSW(?:OR)?D|TOKEN|CREDENTIAL|PRIVATE|(?:^|_)PAT(?:_|$)"
)
_DARWIN_ROOT_SYMLINKS: dict[str, str] = {
    "/var": "private/var",
    "/tmp": "private/tmp",
    "/etc": "private/etc",
}


class StunProtocolError(ValueError):
    """Raised when a STUN or TURN frame or credential violates RFC 5389 / RFC 5766."""


class TransactionMismatchError(StunProtocolError):
    """Raised when a received STUN packet carries an unrelated transaction ID."""


@dataclass(frozen=True)
class TransportAddress:
    ip: str
    port: int
    family: str

    def to_dict(self) -> dict[str, object]:
        return {"ip": self.ip, "port": self.port, "family": self.family}


@dataclass(frozen=True)
class ParsedStunMessage:
    msg_type: int
    txid: bytes
    attributes: tuple[tuple[int, bytes], ...]

    def first_attr(self, attr_type: int) -> bytes | None:
        for kind, raw in self.attributes:
            if kind == attr_type:
                return raw
        return None


def redact_secrets(text: str, secret_values: Iterable[str]) -> str:
    """Scrub secret strings before emitting logs, JSON fields, or exceptions."""
    candidates = sorted(
        {val for val in secret_values if isinstance(val, str) and len(val) >= 4},
        key=len,
        reverse=True,
    )
    scrubbed = text
    for secret in candidates:
        scrubbed = scrubbed.replace(secret, "[REDACTED]")
    return scrubbed


def verify_path_ancestors_no_symlink(target: Path, *, must_exist: bool = True) -> Path:
    """Verify every non-root ancestor component of `target` is free of symbolic links.

    On macOS (`darwin`), top-level OS aliases `/var -> private/var`, `/tmp -> private/tmp`,
    and `/etc -> private/etc` are stepped into canonically while every component beneath
    them (and all other paths) is strictly checked with `lstat`.
    """
    abs_str = os.path.abspath(os.fspath(target))
    parts = [part for part in abs_str.split(os.sep) if part]
    current = Path(os.sep)

    for idx, part in enumerate(parts):
        candidate = current / part
        is_last = idx == len(parts) - 1
        try:
            st = os.lstat(candidate)
        except FileNotFoundError:
            if not is_last or must_exist:
                raise ValueError(f"path does not exist: {target}") from None
            current = candidate
            continue
        except OSError as exc:
            raise ValueError(
                f"cannot stat path component {candidate}: {exc.strerror or 'os error'}"
            ) from None

        if stat.S_ISLNK(st.st_mode):
            if idx == 0 and sys.platform == "darwin":
                expected_link = _DARWIN_ROOT_SYMLINKS.get(f"/{part}")
                try:
                    actual_link = os.readlink(candidate).rstrip("/")
                except OSError:
                    actual_link = ""
                if expected_link and actual_link == expected_link:
                    current = Path(os.sep) / expected_link
                    continue
            raise ValueError(f"refusing symbolic link in path: {candidate}")
        current = candidate

    if must_exist and os.path.realpath(abs_str) != str(current):
        raise ValueError(f"path reached through symbolic link: {target}")
    return current


def read_env_file_safe(path: Path) -> tuple[dict[str, str], set[str]]:
    """Read an operator .env file via ancestor symlink check and O_NOFOLLOW."""
    canonical = verify_path_ancestors_no_symlink(path, must_exist=True)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(canonical, flags)
    try:
        fst = os.fstat(fd)
        if not stat.S_ISREG(fst.st_mode):
            raise ValueError(f"env file is not a regular file: {path}")
        raw = os.read(fd, 262_144)
    finally:
        os.close(fd)
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise ValueError(f"env file is not valid UTF-8: {path}") from None

    parsed: dict[str, str] = {}
    secrets_found: set[str] = set()
    for line_no, raw_line in enumerate(content.splitlines(), start=1):
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = ENV_LINE_RE.match(stripped)
        if not match:
            raise ValueError(f"env file line {line_no}: malformed assignment (value redacted)")
        key, val = match.group(1), match.group(2).strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
            val = val[1:-1]
        parsed[key] = val
        if val and (SECRET_KEY_NAME_RE.search(key) or key == "KODERA_AUTH_TRUST"):
            secrets_found.add(val)
    return parsed, secrets_found


def saslprep(value: str) -> str:
    """Normalize and validate a STUN/TURN username or password per RFC 4013 (Unicode 3.2 SASLprep)."""
    mapped: list[str] = []
    for ch in value:
        if stringprep.in_table_b1(ch):
            continue
        if stringprep.in_table_c12(ch):
            mapped.append(" ")
        else:
            mapped.append(ch)

    # RFC 4013 Section 2.2 mandates Unicode 3.2 NFKC normalization.
    normalized = unicodedata.ucd_3_2_0.normalize("NFKC", "".join(mapped))

    for ch in normalized:
        if (
            stringprep.in_table_a1(ch)
            or stringprep.in_table_c12(ch)
            or stringprep.in_table_c21(ch)
            or stringprep.in_table_c22(ch)
            or stringprep.in_table_c3(ch)
            or stringprep.in_table_c4(ch)
            or stringprep.in_table_c5(ch)
            or stringprep.in_table_c6(ch)
            or stringprep.in_table_c7(ch)
            or stringprep.in_table_c8(ch)
            or stringprep.in_table_c9(ch)
        ):
            raise StunProtocolError("credential contains prohibited SASLprep character")

    if normalized and any(stringprep.in_table_d1(ch) for ch in normalized):
        if any(stringprep.in_table_d2(ch) for ch in normalized):
            raise StunProtocolError("credential violates SASLprep bidirectional LCat/RandALCat rule")
        if not (stringprep.in_table_d1(normalized[0]) and stringprep.in_table_d1(normalized[-1])):
            raise StunProtocolError("credential violates SASLprep bidirectional boundary rule")

    return normalized


def _pad4(value: bytes) -> bytes:
    rem = len(value) % 4
    return value if rem == 0 else value + (b"\x00" * (4 - rem))


def encode_attr(attr_type: int, value: bytes) -> bytes:
    if not (0 <= attr_type <= 0xFFFF):
        raise StunProtocolError("attribute type out of 16-bit range")
    if len(value) > 0xFFFF:
        raise StunProtocolError("attribute value exceeds 65535 bytes")
    return STUN_ATTR_HEADER_STRUCT.pack(attr_type, len(value)) + _pad4(value)


def encode_xor_address(ip: str, port: int, txid: bytes) -> bytes:
    """Encode an IPv4 or IPv6 transport address per RFC 5389 Section 15.2."""
    if len(txid) != 12:
        raise StunProtocolError("txid must be exactly 12 bytes")
    if not (0 <= port <= 0xFFFF):
        raise StunProtocolError("port out of 16-bit range")
    addr = ipaddress.ip_address(ip)
    xport = port ^ (STUN_MAGIC_COOKIE >> 16)
    cookie_bytes = struct.pack(">I", STUN_MAGIC_COOKIE)
    if addr.version == 4:
        xaddr = bytes(a ^ b for a, b in zip(addr.packed, cookie_bytes, strict=True))
        return struct.pack(">BBH4s", 0, 0x01, xport, xaddr)
    mask = cookie_bytes + txid
    xaddr = bytes(a ^ b for a, b in zip(addr.packed, mask, strict=True))
    return struct.pack(">BBH16s", 0, 0x02, xport, xaddr)


def decode_xor_address(value: bytes, txid: bytes) -> TransportAddress:
    """Decode an IPv4 or IPv6 XOR-MAPPED-ADDRESS / XOR-RELAYED-ADDRESS / XOR-PEER-ADDRESS."""
    if len(txid) != 12:
        raise StunProtocolError("txid must be exactly 12 bytes")
    if len(value) < 4:
        raise StunProtocolError("XOR address attribute shorter than 4 bytes")
    family = value[1]
    xport = struct.unpack_from(">H", value, 2)[0]
    port = xport ^ (STUN_MAGIC_COOKIE >> 16)
    cookie_bytes = struct.pack(">I", STUN_MAGIC_COOKIE)
    if family == 0x01:
        if len(value) != 8:
            raise StunProtocolError("IPv4 XOR address attribute must be 8 bytes")
        raw_ip = bytes(a ^ b for a, b in zip(value[4:8], cookie_bytes, strict=True))
        return TransportAddress(str(ipaddress.IPv4Address(raw_ip)), port, "IPv4")
    if family == 0x02:
        if len(value) != 20:
            raise StunProtocolError("IPv6 XOR address attribute must be 20 bytes")
        mask = cookie_bytes + txid
        raw_ip = bytes(a ^ b for a, b in zip(value[4:20], mask, strict=True))
        return TransportAddress(str(ipaddress.IPv6Address(raw_ip)), port, "IPv6")
    raise StunProtocolError(f"unsupported STUN address family: 0x{family:02x}")


def decode_mapped_address(value: bytes) -> TransportAddress:
    """Decode legacy RFC 5389 Section 15.1 MAPPED-ADDRESS fallback."""
    if len(value) < 4:
        raise StunProtocolError("MAPPED-ADDRESS shorter than 4 bytes")
    family = value[1]
    port = struct.unpack_from(">H", value, 2)[0]
    if family == 0x01 and len(value) == 8:
        return TransportAddress(str(ipaddress.IPv4Address(value[4:8])), port, "IPv4")
    if family == 0x02 and len(value) == 20:
        return TransportAddress(str(ipaddress.IPv6Address(value[4:20])), port, "IPv6")
    raise StunProtocolError("malformed MAPPED-ADDRESS attribute")


def encode_error_code(code: int, reason: str = "") -> bytes:
    if not (300 <= code <= 699):
        raise StunProtocolError("STUN error code must be in 300..699")
    cls = code // 100
    number = code % 100
    return struct.pack(">BBBB", 0, 0, cls & 0x07, number) + reason.encode()


def decode_error_code(value: bytes) -> tuple[int, str]:
    if len(value) < 4:
        raise StunProtocolError("ERROR-CODE attribute shorter than 4 bytes")
    cls = value[2] & 0x07
    number = value[3]
    if number >= 100:
        raise StunProtocolError("ERROR-CODE number >= 100")
    reason = value[4:].decode("utf-8", "replace")
    return cls * 100 + number, reason


def derive_long_term_key(username: str, realm: str, password: str) -> bytes:
    """RFC 5389 Section 15.4 long-term key: MD5(SASLprep(username):realm:SASLprep(password))."""
    norm_user = saslprep(username)
    norm_pass = saslprep(password)
    material = f"{norm_user}:{realm}:{norm_pass}".encode()
    return hashlib.md5(material, usedforsecurity=False).digest()


def derive_short_term_key(password: str) -> bytes:
    """RFC 5389 Section 15.4 short-term key: UTF-8(SASLprep(password))."""
    return saslprep(password).encode()


def build_stun_message(
    msg_type: int,
    *,
    txid: bytes | None = None,
    attributes: Sequence[tuple[int, bytes]] = (),
    integrity_key: bytes | None = None,
    fingerprint: bool = False,
) -> tuple[bytes, bytes]:
    """Build an RFC 5389 / RFC 5766 message and return (wire_bytes, txid)."""
    if (msg_type & 0xC000) != 0:
        raise StunProtocolError("top two bits of STUN message type must be zero")
    tx = secrets.token_bytes(12) if txid is None else txid
    if len(tx) != 12:
        raise StunProtocolError("STUN transaction ID must be 12 bytes")

    body = b"".join(encode_attr(kind, val) for kind, val in attributes)

    if integrity_key is not None:
        # RFC 5389 Section 15.4: header length covers through the end of MESSAGE-INTEGRITY (24 bytes),
        # excluding any attributes placed after MESSAGE-INTEGRITY (such as FINGERPRINT).
        mi_len = len(body) + 24
        mi_header = STUN_HEADER_STRUCT.pack(msg_type, mi_len, STUN_MAGIC_COOKIE, tx)
        digest = hmac.new(integrity_key, mi_header + body, hashlib.sha1).digest()
        body += encode_attr(ATTR_MESSAGE_INTEGRITY, digest)

    if fingerprint:
        # RFC 5389 Section 15.5: header length includes the 8-byte FINGERPRINT attribute itself.
        fp_len = len(body) + 8
        fp_header = STUN_HEADER_STRUCT.pack(msg_type, fp_len, STUN_MAGIC_COOKIE, tx)
        crc = (zlib.crc32(fp_header + body) & 0xFFFFFFFF) ^ STUN_FINGERPRINT_XOR
        body += encode_attr(ATTR_FINGERPRINT, struct.pack(">I", crc))

    header = STUN_HEADER_STRUCT.pack(msg_type, len(body), STUN_MAGIC_COOKIE, tx)
    return header + body, tx


def parse_stun_message(
    packet: bytes,
    *,
    expected_txid: bytes | None = None,
    integrity_key: bytes | None = None,
    require_fingerprint: bool = False,
) -> ParsedStunMessage:
    """Parse and cryptographically validate a STUN/TURN wire datagram.

    Per RFC 5389 Section 15.4, once MESSAGE-INTEGRITY (0x0008) is encountered,
    all subsequent attributes except FINGERPRINT (0x8028) are ignored.
    """
    if len(packet) < STUN_HEADER_STRUCT.size:
        raise StunProtocolError("packet shorter than 20-byte STUN header")
    msg_type, msg_len, cookie, txid = STUN_HEADER_STRUCT.unpack_from(packet, 0)
    if (msg_type & 0xC000) != 0:
        raise StunProtocolError("non-zero top two bits in STUN message type")
    if cookie != STUN_MAGIC_COOKIE:
        raise StunProtocolError("invalid STUN magic cookie")
    if (msg_len % 4) != 0:
        raise StunProtocolError("STUN message length is not a multiple of 4")
    if len(packet) != STUN_HEADER_STRUCT.size + msg_len:
        raise StunProtocolError("packet length does not match STUN header length")
    if expected_txid is not None and txid != expected_txid:
        raise TransactionMismatchError("STUN transaction ID mismatch")

    attrs: list[tuple[int, bytes]] = []
    offset = STUN_HEADER_STRUCT.size
    mi_offset: int | None = None
    mi_value: bytes | None = None
    fp_offset: int | None = None
    fp_value: bytes | None = None

    while offset < len(packet):
        if offset + STUN_ATTR_HEADER_STRUCT.size > len(packet):
            raise StunProtocolError("truncated STUN attribute header")
        attr_type, attr_len = STUN_ATTR_HEADER_STRUCT.unpack_from(packet, offset)
        val_start = offset + STUN_ATTR_HEADER_STRUCT.size
        val_end = val_start + attr_len
        padded_end = val_start + ((attr_len + 3) & ~3)
        if padded_end > len(packet):
            raise StunProtocolError("STUN attribute exceeds packet bounds")
        raw_val = packet[val_start:val_end]

        if mi_offset is not None:
            # RFC 5389 Section 15.4: ignore all attributes after MESSAGE-INTEGRITY except FINGERPRINT.
            if attr_type == ATTR_FINGERPRINT:
                if attr_len != 4 or padded_end != len(packet):
                    raise StunProtocolError("FINGERPRINT must be a trailing 4-byte attribute")
                fp_offset = offset
                fp_value = raw_val
                attrs.append((attr_type, raw_val))
            offset = padded_end
            continue

        if attr_type == ATTR_MESSAGE_INTEGRITY:
            if attr_len != 20:
                raise StunProtocolError("MESSAGE-INTEGRITY must be 20 bytes")
            mi_offset = offset
            mi_value = raw_val
            attrs.append((attr_type, raw_val))
        elif attr_type == ATTR_FINGERPRINT:
            if attr_len != 4 or padded_end != len(packet):
                raise StunProtocolError("FINGERPRINT must be a trailing 4-byte attribute")
            fp_offset = offset
            fp_value = raw_val
            attrs.append((attr_type, raw_val))
        else:
            attrs.append((attr_type, raw_val))
        offset = padded_end

    if require_fingerprint and fp_offset is None:
        raise StunProtocolError("missing required FINGERPRINT attribute")

    if fp_offset is not None and fp_value is not None:
        prefix_body = packet[STUN_HEADER_STRUCT.size:fp_offset]
        adjusted_header = STUN_HEADER_STRUCT.pack(
            msg_type, len(prefix_body) + 8, STUN_MAGIC_COOKIE, txid
        )
        expected_crc = (zlib.crc32(adjusted_header + prefix_body) & 0xFFFFFFFF) ^ STUN_FINGERPRINT_XOR
        actual_crc = struct.unpack(">I", fp_value)[0]
        if actual_crc != expected_crc:
            raise StunProtocolError("STUN FINGERPRINT CRC-32 mismatch")

    if integrity_key is not None:
        if mi_offset is None or mi_value is None:
            raise StunProtocolError("missing required MESSAGE-INTEGRITY attribute")
        prefix_body = packet[STUN_HEADER_STRUCT.size:mi_offset]
        adjusted_header = STUN_HEADER_STRUCT.pack(
            msg_type, len(prefix_body) + 24, STUN_MAGIC_COOKIE, txid
        )
        expected_hmac = hmac.new(integrity_key, adjusted_header + prefix_body, hashlib.sha1).digest()
        if not hmac.compare_digest(mi_value, expected_hmac):
            raise StunProtocolError("STUN MESSAGE-INTEGRITY HMAC-SHA1 verification failed")

    return ParsedStunMessage(msg_type=msg_type, txid=txid, attributes=tuple(attrs))


def parse_ports_spec(spec: str, *, max_ports: int = 16) -> list[int]:
    """Parse comma-separated ports or ranges (e.g. `3478`, `3478,5349`, `50000-50002`)."""
    ports: list[int] = []
    for raw_part in spec.split(","):
        part = raw_part.strip()
        if not part:
            continue
        if "-" in part:
            start_s, _, end_s = part.partition("-")
            if not start_s.isdigit() or not end_s.isdigit():
                raise ValueError(f"invalid port range '{part}'")
            start_p, end_p = int(start_s), int(end_s)
            if start_p < 1 or end_p > 65535 or start_p > end_p:
                raise ValueError(f"port range out of bounds '{part}'")
            for p in range(start_p, min(end_p + 1, start_p + max_ports)):
                if p not in ports:
                    ports.append(p)
        else:
            if not part.isdigit():
                raise ValueError(f"invalid port number '{part}'")
            p = int(part)
            if not (1 <= p <= 65535):
                raise ValueError(f"port out of bounds '{part}'")
            if p not in ports:
                ports.append(p)
        if len(ports) >= max_ports:
            break
    if not ports:
        raise ValueError("at least one valid UDP port is required")
    return ports[:max_ports]


def parse_turn_url(turn_url: str) -> tuple[str, int]:
    """Parse `turn:host:port[?transport=udp]` or `host:port` into `(host, port)`."""
    raw = turn_url.strip()
    if not raw:
        raise ValueError("empty TURN URL")
    lower = raw.lower()
    if lower.startswith("turns:"):
        raise ValueError("turns: TLS transport is not valid for raw UDP allocation probe; use turn:")
    if lower.startswith("turn:"):
        remainder = raw[5:].removeprefix("//")
        parsed = urlsplit("turn://" + remainder)
    elif "://" in raw:
        raise ValueError("unsupported TURN URL scheme; expected turn:")
    else:
        parsed = urlsplit("turn://" + raw)

    if parsed.username or parsed.password:
        raise ValueError("do not embed credentials in TURN URL; use --turn-username and password env")
    if not parsed.hostname:
        raise ValueError("TURN URL missing hostname")
    if parsed.query:
        qs = parse_qs(parsed.query, keep_blank_values=True)
        transports = [t.lower() for t in qs.get("transport", ["udp"])]
        if any(t != "udp" for t in transports):
            raise ValueError("only UDP transport (?transport=udp) is supported by UDP probe")
    try:
        port = parsed.port or DEFAULT_TURN_PORT
    except ValueError as exc:
        raise ValueError("invalid port in TURN URL") from exc
    if not (1 <= port <= 65535):
        raise ValueError("TURN port out of range 1..65535")
    return parsed.hostname, port


def _getaddrinfo_bounded(
    host: str,
    port: int | None,
    *,
    deadline: float,
) -> list[tuple[int, int, int, str, tuple[object, ...]]]:
    """Resolve `host` within monotonic `deadline`, fast-pathing IP literals without DNS."""
    stripped = host.strip().lstrip("[").rstrip("]")
    try:
        ip_obj = ipaddress.ip_address(stripped)
    except ValueError:
        ip_obj = None

    if ip_obj is not None:
        fam = socket.AF_INET6 if ip_obj.version == 6 else socket.AF_INET
        return socket.getaddrinfo(
            str(ip_obj),
            port,
            family=fam,
            type=socket.SOCK_DGRAM,
            flags=socket.AI_NUMERICHOST,
        )

    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError(f"DNS deadline exceeded resolving {host}")

    result_q: queue.Queue[tuple[list[tuple[int, int, int, str, tuple[object, ...]]] | None, BaseException | None]] = (
        queue.Queue(maxsize=1)
    )

    def _worker() -> None:
        try:
            infos = socket.getaddrinfo(host, port, type=socket.SOCK_DGRAM)
            result_q.put((infos, None))
        except BaseException as exc:  # noqa: BLE001
            result_q.put((None, exc))

    t = threading.Thread(target=_worker, daemon=True)
    t.start()
    try:
        infos, err = result_q.get(timeout=remaining)
    except queue.Empty:
        raise TimeoutError(f"DNS resolution timed out for {host}") from None
    if err is not None:
        if isinstance(err, OSError):
            raise err
        raise OSError(str(err))
    return infos or []


def resolve_udp_endpoints(
    host: str,
    port: int,
    *,
    deadline: float | None = None,
) -> list[tuple[int, tuple[object, ...], str]]:
    """Resolve host/port into `(family, sockaddr, normalized_ip)` entries within `deadline`."""
    eff_deadline = (time.monotonic() + 1.0) if deadline is None else deadline
    infos = _getaddrinfo_bounded(host, port, deadline=eff_deadline)
    seen: set[tuple[str, int]] = set()
    endpoints: list[tuple[int, tuple[object, ...], str]] = []
    for family, _socktype, _proto, _canon, sockaddr in infos:
        if family not in (socket.AF_INET, socket.AF_INET6):
            continue
        ip_str = str(ipaddress.ip_address(str(sockaddr[0]).split("%", 1)[0]))
        key = (ip_str, int(sockaddr[1]))  # type: ignore[arg-type]
        if key not in seen:
            seen.add(key)
            endpoints.append((family, sockaddr, ip_str))
    if not endpoints:
        raise OSError(f"no IPv4/IPv6 UDP address resolved for {host}")
    return endpoints


def resolve_domain_ips(domain: str, *, deadline: float | None = None) -> list[str]:
    """Resolve public/configured IPs for KODERA_DOMAIN within `deadline`."""
    eff_deadline = (time.monotonic() + 0.6) if deadline is None else deadline
    try:
        infos = _getaddrinfo_bounded(domain, None, deadline=eff_deadline)
    except OSError:
        return []
    ips: list[str] = []
    for family, _socktype, _proto, _canon, sockaddr in infos:
        if family in (socket.AF_INET, socket.AF_INET6):
            ip_norm = str(ipaddress.ip_address(str(sockaddr[0]).split("%", 1)[0]))
            if ip_norm not in ips:
                ips.append(ip_norm)
    return ips


def _discover_local_address(family: int, sockaddr: tuple[object, ...]) -> TransportAddress:
    with socket.socket(family, socket.SOCK_DGRAM) as probe_sock:
        probe_sock.connect(sockaddr)
        bound = probe_sock.getsockname()
        ip_norm = str(ipaddress.ip_address(str(bound[0]).split("%", 1)[0]))
        fam_label = "IPv6" if family == socket.AF_INET6 else "IPv4"
        return TransportAddress(ip=ip_norm, port=int(bound[1]), family=fam_label)


def _send_and_await(
    sock: socket.socket,
    dest: tuple[object, ...],
    packet: bytes,
    *,
    expected_txid: bytes | None,
    deadline: float,
    step_timeout: float = 0.35,
    integrity_key: bytes | None = None,
    require_fingerprint: bool = False,
    max_attempts: int = 3,
    initial_rto: float = 0.10,
) -> tuple[ParsedStunMessage, float]:
    """Send a UDP STUN/TURN request with bounded RFC 5389 RTO retransmission."""
    started = time.monotonic()
    remaining = deadline - started
    if remaining <= 0:
        raise TimeoutError("probe deadline exceeded")
    total_step = min(step_timeout, remaining)
    step_end = started + total_step
    attempts = max(1, max_attempts) if total_step >= 0.03 else 1
    rto = min(initial_rto, total_step / attempts) if attempts > 1 else total_step

    for attempt in range(attempts):
        now = time.monotonic()
        if now >= step_end:
            break
        sock.sendto(packet, dest)
        attempt_budget = (step_end - now) if attempt == attempts - 1 else min(rto * (1.5**attempt), step_end - now)
        attempt_end = now + max(0.005, attempt_budget)

        while True:
            left = attempt_end - time.monotonic()
            if left <= 0:
                break
            sock.settimeout(left)
            try:
                raw, _peer = sock.recvfrom(4096)
            except TimeoutError:
                break
            try:
                parsed = parse_stun_message(
                    raw,
                    expected_txid=expected_txid,
                    integrity_key=integrity_key,
                    require_fingerprint=require_fingerprint,
                )
            except TransactionMismatchError:
                continue
            rtt_ms = round((time.monotonic() - started) * 1000.0, 3)
            return parsed, rtt_ms

    raise TimeoutError("UDP response timed out")


def _await_indication(
    sock: socket.socket,
    expected_msg_type: int,
    *,
    deadline: float,
    step_timeout: float = 0.35,
) -> tuple[ParsedStunMessage, float]:
    """Wait for a TURN Data Indication (0x0017) on an open UDP socket."""
    started = time.monotonic()
    remaining = deadline - started
    if remaining <= 0:
        raise TimeoutError("probe deadline exceeded")
    step_end = started + min(step_timeout, remaining)
    while True:
        left = step_end - time.monotonic()
        if left <= 0:
            raise TimeoutError("TURN Data Indication timed out")
        sock.settimeout(left)
        raw, _peer = sock.recvfrom(4096)
        try:
            parsed = parse_stun_message(raw, expected_txid=None)
        except StunProtocolError:
            continue
        if parsed.msg_type == expected_msg_type:
            rtt_ms = round((time.monotonic() - started) * 1000.0, 3)
            return parsed, rtt_ms


def probe_stun_binding(
    host: str,
    ports: Sequence[int],
    *,
    deadline: float,
    step_timeout: float = 0.30,
    username: str | None = None,
    password: str | None = None,
    fingerprint: bool = False,
) -> dict[str, object]:
    """Send RFC 5389 STUN Binding Request(s) and return reflexive mapping details."""
    if not ports:
        raise ValueError("at least one STUN UDP port is required")
    attrs: list[tuple[int, bytes]] = []
    integrity_key: bytes | None = None
    use_fp = fingerprint
    if username:
        norm_user = saslprep(username)
        attrs.append((ATTR_USERNAME, norm_user.encode()))
        if password is not None:
            integrity_key = derive_short_term_key(password)
            use_fp = True

    last_error: str | None = None
    local_addr: TransportAddress | None = None

    for port in ports:
        if time.monotonic() >= deadline:
            last_error = "probe deadline exceeded"
            break
        try:
            endpoints = resolve_udp_endpoints(host, port, deadline=deadline)
        except OSError as exc:
            last_error = f"DNS/address resolution failed for {host}:{port}: {exc.strerror or type(exc).__name__}"
            continue

        for family, sockaddr, target_ip in endpoints:
            if time.monotonic() >= deadline:
                break
            with contextlib.suppress(OSError):
                local_addr = _discover_local_address(family, sockaddr)
            with socket.socket(family, socket.SOCK_DGRAM) as sock:
                req_bytes, txid = build_stun_message(
                    MSG_BINDING_REQUEST,
                    attributes=attrs,
                    integrity_key=integrity_key,
                    fingerprint=use_fp,
                )
                try:
                    resp, rtt_ms = _send_and_await(
                        sock,
                        sockaddr,
                        req_bytes,
                        expected_txid=txid,
                        deadline=deadline,
                        step_timeout=step_timeout,
                        integrity_key=integrity_key,
                        require_fingerprint=False,
                    )
                except (TimeoutError, ConnectionRefusedError, ConnectionResetError, OSError) as exc:
                    last_error = type(exc).__name__
                    continue
                except StunProtocolError as exc:
                    last_error = str(exc)
                    continue
                finally:
                    with contextlib.suppress(OSError):
                        bound_port = int(sock.getsockname()[1])
                        if local_addr is not None and bound_port > 0:
                            local_addr = TransportAddress(
                                local_addr.ip, bound_port, local_addr.family
                            )

                if resp.msg_type == MSG_BINDING_ERROR:
                    err_attr = resp.first_attr(ATTR_ERROR_CODE)
                    code, _reason = decode_error_code(err_attr) if err_attr else (0, "")
                    last_error = f"STUN Binding Error {code}"
                    continue
                if resp.msg_type != MSG_BINDING_SUCCESS:
                    last_error = f"unexpected STUN message type 0x{resp.msg_type:04x}"
                    continue

                xor_raw = resp.first_attr(ATTR_XOR_MAPPED_ADDRESS)
                mapped_raw = resp.first_attr(ATTR_MAPPED_ADDRESS)
                if xor_raw is not None:
                    reflexive = decode_xor_address(xor_raw, txid)
                elif mapped_raw is not None:
                    reflexive = decode_mapped_address(mapped_raw)
                else:
                    last_error = "Binding Success Response lacked XOR-MAPPED-ADDRESS"
                    continue

                return {
                    "attempted": True,
                    "succeeded": True,
                    "host": host,
                    "target_ip": target_ip,
                    "port": port,
                    "rtt_ms": rtt_ms,
                    "local_address": local_addr,
                    "reflexive_address": reflexive,
                    "error": None,
                }

    return {
        "attempted": True,
        "succeeded": False,
        "host": host,
        "target_ip": None,
        "port": ports[0],
        "rtt_ms": None,
        "local_address": local_addr,
        "reflexive_address": None,
        "error": last_error or "no STUN response",
    }


def _deallocate_turn_allocation(
    sock: socket.socket,
    sockaddr: tuple[object, ...],
    *,
    username: str,
    password: str,
    realm: str,
    nonce: bytes,
    deadline: float,
    max_attempts: int = 3,
    initial_rto: float = 0.045,
) -> tuple[bool, str | None]:
    """Send TURN Refresh(LIFETIME=0) with bounded RTO, 438 retry, and authenticated 437 check."""
    norm_user = saslprep(username)
    cur_realm = realm
    cur_nonce = nonce

    for nonce_attempt in range(2):
        remaining_total = deadline - time.monotonic()
        if remaining_total <= 0:
            return False, "TURN Refresh(0) deadline exceeded"

        cur_key = derive_long_term_key(norm_user, cur_realm, password)
        refresh_attrs = (
            (ATTR_LIFETIME, struct.pack(">I", 0)),
            (ATTR_USERNAME, norm_user.encode()),
            (ATTR_REALM, cur_realm.encode()),
            (ATTR_NONCE, cur_nonce),
        )
        refresh_pkt, refresh_txid = build_stun_message(
            MSG_REFRESH_REQUEST,
            attributes=refresh_attrs,
            integrity_key=cur_key,
            fingerprint=True,
        )

        # Bounded RTO retransmission loop within the reserved cleanup budget.
        phase_budget = min(0.22, remaining_total)
        phase_end = time.monotonic() + phase_budget
        attempts = max(1, max_attempts) if phase_budget >= 0.03 else 1
        base_rto = min(initial_rto, phase_budget / attempts) if attempts > 1 else phase_budget
        rotated_stale_nonce = False

        for rto_try in range(attempts):
            now = time.monotonic()
            if now >= phase_end:
                break
            sock.sendto(refresh_pkt, sockaddr)
            try_budget = (
                (phase_end - now)
                if rto_try == attempts - 1
                else min(base_rto * (1.5**rto_try), phase_end - now)
            )
            try_end = now + max(0.005, try_budget)

            while True:
                left = try_end - time.monotonic()
                if left <= 0:
                    break
                sock.settimeout(left)
                try:
                    candidate, _ = sock.recvfrom(4096)
                except TimeoutError:
                    break
                except OSError as exc:
                    return False, f"TURN Refresh(0) failed: {type(exc).__name__}"

                try:
                    resp_msg = parse_stun_message(candidate, expected_txid=refresh_txid)
                except (TransactionMismatchError, StunProtocolError):
                    continue

                if resp_msg.msg_type == MSG_REFRESH_SUCCESS:
                    try:
                        verified = parse_stun_message(
                            candidate,
                            expected_txid=refresh_txid,
                            integrity_key=cur_key,
                        )
                    except StunProtocolError:
                        # RFC 5389 Section 10.2.3: discard unauthenticated/wrong-key response.
                        continue
                    lifetime_raw = verified.first_attr(ATTR_LIFETIME)
                    if lifetime_raw is None or len(lifetime_raw) != 4:
                        return False, "TURN Refresh(0) response missing 4-byte LIFETIME"
                    confirmed_lifetime = struct.unpack(">I", lifetime_raw)[0]
                    if confirmed_lifetime != 0:
                        return False, f"TURN Refresh(0) returned non-zero LIFETIME={confirmed_lifetime}"
                    return True, None

                if resp_msg.msg_type == MSG_REFRESH_ERROR:
                    err_raw = resp_msg.first_attr(ATTR_ERROR_CODE)
                    code, _ = decode_error_code(err_raw) if err_raw else (0, "")
                    if code == 438 and nonce_attempt == 0:
                        new_nonce = resp_msg.first_attr(ATTR_NONCE)
                        new_realm = resp_msg.first_attr(ATTR_REALM)
                        if new_nonce:
                            cur_nonce = new_nonce
                            if new_realm:
                                cur_realm = new_realm.decode("utf-8", "replace")
                            rotated_stale_nonce = True
                            break
                        return False, "TURN Refresh(0) 438 Stale Nonce lacked NONCE"

                    # RFC 5389 Section 10.2.3: any non-401/438 error response (including 437
                    # Allocation Mismatch) MUST carry a valid MESSAGE-INTEGRITY for `cur_key`
                    # or be silently discarded as spoofed/corrupted.
                    if code == 401:
                        return False, "TURN Refresh(0) rejected with 401"
                    try:
                        parse_stun_message(
                            candidate,
                            expected_txid=refresh_txid,
                            integrity_key=cur_key,
                        )
                    except StunProtocolError:
                        continue
                    if code == 437:
                        return True, None
                    return False, f"TURN Refresh(0) rejected with {code}"

            if rotated_stale_nonce:
                break

        if not rotated_stale_nonce:
            return False, "TURN Refresh(0) timed out"

    return False, "TURN Refresh(0) stale nonce retry exhausted"


def probe_turn_loopback(
    turn_url: str,
    username: str,
    password: str,
    *,
    deadline: float,
    step_timeout: float = 0.35,
) -> dict[str, object]:
    """Execute RFC 5766 TURN UDP Allocate -> CreatePermission -> Send/Data -> Refresh(0)."""
    norm_user = saslprep(username)
    saslprep(password)
    host, port = parse_turn_url(turn_url)

    now = time.monotonic()
    total_remaining = max(0.05, deadline - now)
    cleanup_reserve = min(0.18, total_remaining * 0.22)
    active_deadline = max(now + 0.03, deadline - cleanup_reserve)

    endpoints = resolve_udp_endpoints(host, port, deadline=active_deadline)
    family, sockaddr, target_ip = endpoints[0]
    local_addr = _discover_local_address(family, sockaddr)

    started = time.monotonic()
    allocated = False
    permission_installed = False
    loopback_verified = False
    deallocated = False
    reflexive_addr: TransportAddress | None = None
    relayed_addr: TransportAddress | None = None
    realm_val = ""
    nonce_val = b""
    failure_reason: str | None = None

    with socket.socket(family, socket.SOCK_DGRAM) as sock:
        transport_attr = (ATTR_REQUESTED_TRANSPORT, struct.pack(">BBBB", TRANSPORT_UDP, 0, 0, 0))

        try:
            # 1. Unauthenticated Allocate (0x0003) -> expect 401 challenge with REALM + NONCE.
            req1, tx1 = build_stun_message(
                MSG_ALLOCATE_REQUEST,
                attributes=(transport_attr,),
                fingerprint=True,
            )
            resp1, _ = _send_and_await(
                sock,
                sockaddr,
                req1,
                expected_txid=tx1,
                deadline=active_deadline,
                step_timeout=step_timeout,
            )
            if resp1.msg_type != MSG_ALLOCATE_ERROR:
                raise StunProtocolError(
                    f"expected 401 Allocate Error challenge, got 0x{resp1.msg_type:04x}"
                )
            err_raw = resp1.first_attr(ATTR_ERROR_CODE)
            err_code, _ = decode_error_code(err_raw) if err_raw else (0, "")
            if err_code != 401:
                raise StunProtocolError(f"expected 401 Unauthorized challenge, got {err_code}")
            realm_bytes = resp1.first_attr(ATTR_REALM)
            nonce_bytes = resp1.first_attr(ATTR_NONCE)
            if not realm_bytes or not nonce_bytes:
                raise StunProtocolError("401 challenge missing REALM or NONCE attribute")
            realm_val = realm_bytes.decode("utf-8")
            nonce_val = nonce_bytes
            key = derive_long_term_key(norm_user, realm_val, password)

            # 2. Authenticated long-term credential Allocate (0x0003).
            auth_attrs = (
                (ATTR_USERNAME, norm_user.encode()),
                (ATTR_REALM, realm_bytes),
                (ATTR_NONCE, nonce_val),
            )
            req2, tx2 = build_stun_message(
                MSG_ALLOCATE_REQUEST,
                attributes=(transport_attr, *auth_attrs),
                integrity_key=key,
                fingerprint=True,
            )
            resp2, _ = _send_and_await(
                sock,
                sockaddr,
                req2,
                expected_txid=tx2,
                deadline=active_deadline,
                step_timeout=step_timeout,
                integrity_key=key,
            )
            if resp2.msg_type == MSG_ALLOCATE_ERROR:
                err_raw2 = resp2.first_attr(ATTR_ERROR_CODE)
                code2, _ = decode_error_code(err_raw2) if err_raw2 else (0, "")
                raise StunProtocolError(f"authenticated TURN Allocate rejected with {code2}")
            if resp2.msg_type != MSG_ALLOCATE_SUCCESS:
                raise StunProtocolError(f"unexpected TURN Allocate response 0x{resp2.msg_type:04x}")

            # Mark allocated BEFORE decoding attributes so malformed attributes still trigger Refresh(0).
            allocated = True

            relayed_raw = resp2.first_attr(ATTR_XOR_RELAYED_ADDRESS)
            mapped_raw = resp2.first_attr(ATTR_XOR_MAPPED_ADDRESS)
            if relayed_raw is None or mapped_raw is None:
                raise StunProtocolError(
                    "TURN Allocate Success missing XOR-RELAYED-ADDRESS or XOR-MAPPED-ADDRESS"
                )
            relayed_addr = decode_xor_address(relayed_raw, tx2)
            reflexive_addr = decode_xor_address(mapped_raw, tx2)

            # 3. CreatePermission (0x0008) for the relayed peer IP.
            perm_txid = secrets.token_bytes(12)
            peer_attr = (
                ATTR_XOR_PEER_ADDRESS,
                encode_xor_address(relayed_addr.ip, relayed_addr.port, perm_txid),
            )
            req3, _ = build_stun_message(
                MSG_CREATE_PERMISSION_REQUEST,
                txid=perm_txid,
                attributes=(peer_attr, *auth_attrs),
                integrity_key=key,
                fingerprint=True,
            )
            resp3, _ = _send_and_await(
                sock,
                sockaddr,
                req3,
                expected_txid=perm_txid,
                deadline=active_deadline,
                step_timeout=step_timeout,
                integrity_key=key,
            )
            if resp3.msg_type != MSG_CREATE_PERMISSION_SUCCESS:
                raise StunProtocolError(
                    f"TURN CreatePermission failed with 0x{resp3.msg_type:04x}"
                )
            permission_installed = True

            # 4. Send Indication (0x0016) carrying a 16-byte cryptographic loopback token,
            # with up to 2 attempts if a loopback UDP datagram is lost.
            loopback_token = secrets.token_bytes(16)
            send_txid = secrets.token_bytes(12)
            send_attrs = (
                (
                    ATTR_XOR_PEER_ADDRESS,
                    encode_xor_address(relayed_addr.ip, relayed_addr.port, send_txid),
                ),
                (ATTR_DATA, loopback_token),
            )
            send_pkt, _ = build_stun_message(
                MSG_SEND_INDICATION,
                txid=send_txid,
                attributes=send_attrs,
                fingerprint=True,
            )
            data_ind: ParsedStunMessage | None = None
            for ind_try in range(2):
                if time.monotonic() >= active_deadline:
                    break
                sock.sendto(send_pkt, sockaddr)
                try:
                    data_ind, _ = _await_indication(
                        sock,
                        MSG_DATA_INDICATION,
                        deadline=active_deadline,
                        step_timeout=step_timeout / 2.0 if ind_try == 0 and step_timeout >= 0.16 else step_timeout,
                    )
                    break
                except TimeoutError:
                    if ind_try == 1:
                        raise
            if data_ind is None:
                raise TimeoutError("TURN Data Indication timed out")

            received_payload = data_ind.first_attr(ATTR_DATA)
            if received_payload is None or not hmac.compare_digest(received_payload, loopback_token):
                raise StunProtocolError("TURN Data Indication payload did not match 16-byte token")
            loopback_verified = True

        except (TimeoutError, ConnectionRefusedError, ConnectionResetError, OSError, StunProtocolError) as exc:
            failure_reason = str(exc) or type(exc).__name__
        finally:
            with contextlib.suppress(OSError):
                bound_port = int(sock.getsockname()[1])
                if bound_port > 0:
                    local_addr = TransportAddress(local_addr.ip, bound_port, local_addr.family)
            # 6. Immediate Refresh(lifetime=0) (0x0004) deallocation within reserved deadline.
            if allocated and realm_val and nonce_val:
                dealloc_ok, dealloc_err = _deallocate_turn_allocation(
                    sock,
                    sockaddr,
                    username=norm_user,
                    password=password,
                    realm=realm_val,
                    nonce=nonce_val,
                    deadline=deadline,
                )
                deallocated = dealloc_ok
                if not dealloc_ok and failure_reason is None:
                    failure_reason = dealloc_err

    total_rtt = round((time.monotonic() - started) * 1000.0, 3)
    return {
        "attempted": True,
        "host": host,
        "target_ip": target_ip,
        "port": port,
        "allocated": allocated,
        "permission_installed": permission_installed,
        "loopback_verified": loopback_verified,
        "deallocated": deallocated,
        "rtt_ms": total_rtt,
        "local_address": local_addr,
        "reflexive_address": reflexive_addr,
        "relayed_address": relayed_addr,
        "error": failure_reason,
    }


def _remediation_for(status: str, *, stun_ports: Sequence[int], domain: str | None) -> list[str]:
    port_desc = f"{min(stun_ports)}-{max(stun_ports)}/udp" if len(stun_ports) > 1 else f"{stun_ports[0]}/udp"
    host_label = domain or "<KODERA_DOMAIN>"
    if status in ("ok", "turn_relay_verified"):
        return []
    if status == "hairpin_nat_blocked":
        return [
            f"Enable NAT reflection (hairpin NAT) on your gateway for UDP ports ({port_desc}) toward {host_label}.",
            f"Or configure split-horizon DNS on the local LAN so {host_label} resolves directly to the host's LAN IP.",
            "Or configure an external RFC 5766 TURN UDP relay (--turn-url / TURN_DOMAIN) so same-NAT peers relay media cleanly.",
        ]
    if status == "relay_loopback_blocked":
        return [
            "Open the TURN relay ephemeral UDP port range (for example 49152-65535/udp) on the TURN host firewall and security group.",
            "Verify the TURN server's `external-ip` / `relay-ip` configuration allows peer UDP packets to reach allocated relay sockets.",
        ]
    return [
        f"Open inbound and outbound UDP ports ({port_desc}) on the host firewall and cloud security group.",
        "Verify the target STUN/TURN listener is running and reachable over UDP (LiveKit ephemeral media ports 50000-50200/udp only answer active ICE calls).",
        "If client networks filter UDP, provision a reachable TURN relay and test with `--turn-url`.",
    ]


def run_probe(
    *,
    stun_host: str | None = None,
    stun_port: int | None = None,
    ports: Sequence[int] | None = None,
    port_range_start: int | None = None,
    port_range_end: int | None = None,
    max_ports: int = DEFAULT_MAX_PORT_SAMPLES,
    stun_username: str | None = None,
    stun_password: str | None = None,
    fingerprint: bool = False,
    turn_url: str | None = None,
    turn_username: str | None = None,
    turn_password: str | None = None,
    domain: str | None = None,
    public_ips: Sequence[str] | None = None,
    hairpin_host: str | None = None,
    hairpin_port: int | None = None,
    local_probe_host: str | None = None,
    local_probe_port: int | None = None,
    timeout_budget: float = DEFAULT_BUDGET_SECONDS,
    step_timeout: float = 0.30,
    extra_secrets: Iterable[str] = (),
) -> dict[str, object]:
    """Run the bounded STUN/TURN UDP diagnostic workflow and classify network posture."""
    if not math.isfinite(timeout_budget) or timeout_budget <= 0 or timeout_budget > 10.0:
        raise ValueError("timeout_budget must be a finite number between 0 and 10.0 seconds")
    if not math.isfinite(step_timeout) or step_timeout <= 0:
        raise ValueError("step_timeout must be a positive finite number")
    if turn_url:
        parse_turn_url(turn_url)
        if not turn_username or turn_password is None:
            raise ValueError("TURN probe requires both turn_username and turn_password")
        saslprep(turn_username)
        saslprep(turn_password)
    if stun_username:
        saslprep(stun_username)
    if stun_password is not None:
        saslprep(stun_password)

    sensitive: set[str] = set(extra_secrets)
    for secret in (stun_password, turn_password):
        if secret:
            sensitive.add(secret)

    started = time.monotonic()
    deadline = started + timeout_budget
    # When TURN is active, cap pre-TURN STUN steps so TURN Allocate + Refresh(0) stay inside budget.
    stun_deadline = (started + timeout_budget * 0.35) if turn_url else deadline

    effective_domain = (domain or "").strip() or None
    if public_ips is not None:
        domain_ips = [str(ipaddress.ip_address(ip)) for ip in public_ips]
    elif effective_domain:
        domain_ips = resolve_domain_ips(effective_domain, deadline=min(stun_deadline, started + 0.4))
    else:
        domain_ips = []

    if ports is not None:
        selected_ports = list(ports)
        if not selected_ports or any(p < 1 or p > 65535 for p in selected_ports):
            raise ValueError("ports must contain valid 1..65535 UDP port numbers")
    elif stun_port is not None:
        if not (1 <= stun_port <= 65535):
            raise ValueError("stun_port must be in 1..65535")
        selected_ports = [stun_port]
    elif port_range_start is not None or port_range_end is not None:
        p_start = DEFAULT_PORT_START if port_range_start is None else port_range_start
        p_end = DEFAULT_PORT_END if port_range_end is None else port_range_end
        if p_start < 1 or p_end > 65535 or p_start > p_end:
            raise ValueError("invalid UDP port range")
        count = max(1, min(max_ports, p_end - p_start + 1))
        selected_ports = list(range(p_start, p_start + count))
    elif turn_url:
        _, parsed_turn_port = parse_turn_url(turn_url)
        selected_ports = [parsed_turn_port]
    else:
        selected_ports = [DEFAULT_STUN_PORT]

    target_stun_host = (
        stun_host
        or (parse_turn_url(turn_url)[0] if turn_url and not effective_domain else None)
        or effective_domain
        or "127.0.0.1"
    ).strip()

    stun_res = probe_stun_binding(
        target_stun_host,
        selected_ports,
        deadline=stun_deadline,
        step_timeout=min(step_timeout, timeout_budget / 2.5),
        username=stun_username,
        password=stun_password,
        fingerprint=fingerprint,
    )

    local_addr: TransportAddress | None = stun_res["local_address"]  # type: ignore[assignment]
    reflexive_addr: TransportAddress | None = stun_res["reflexive_address"]  # type: ignore[assignment]
    relayed_addr: TransportAddress | None = None

    # Track whether direct UDP STUN to the public domain IP was attempted and whether it succeeded.
    # If direct public STUN succeeded, the client's hairpin/direct UDP path is proven healthy and
    # any subsequent TURN relay failure MUST classify as `relay_loopback_blocked`, never hairpin!
    stun_targeted_public_domain = bool(
        (effective_domain and target_stun_host == effective_domain)
        or (domain_ips and target_stun_host in domain_ips)
        or (stun_res["target_ip"] and stun_res["target_ip"] in domain_ips)
    )
    direct_public_stun_attempted = stun_targeted_public_domain
    direct_public_stun_succeeded = bool(stun_targeted_public_domain and stun_res["succeeded"])
    local_or_control_listener_alive = bool(stun_res["succeeded"])

    # Reference STUN succeeded (on a non-domain endpoint or with explicit hairpin_host): probe the
    # public/hairpin endpoint directly to test whether NAT reflection drops UDP.
    if stun_res["succeeded"] and reflexive_addr is not None and local_addr is not None:
        shares_domain_nat = bool(domain_ips) and (
            reflexive_addr.ip in domain_ips and local_addr.ip != reflexive_addr.ip
        )
        hp_host = hairpin_host or (
            domain_ips[0] if (shares_domain_nat and not stun_targeted_public_domain) else None
        )
        hp_port = hairpin_port or selected_ports[0]
        if hp_host is not None and time.monotonic() < stun_deadline:
            direct_public_stun_attempted = True
            hp_probe = probe_stun_binding(
                hp_host,
                [hp_port],
                deadline=stun_deadline,
                step_timeout=min(step_timeout, 0.20),
                username=stun_username,
                password=stun_password,
                fingerprint=fingerprint,
            )
            direct_public_stun_succeeded = bool(hp_probe["succeeded"])

    # Primary STUN failed/timed out: if an auxiliary/local probe was supplied, check if it answers
    # AND proves shared public IP (unrelated 127.0.0.1 responses without shared-NAT proof do not).
    if not stun_res["succeeded"] and local_probe_host and time.monotonic() < stun_deadline:
        if bool(domain_ips):
            direct_public_stun_attempted = True
        lp_port = local_probe_port or selected_ports[0]
        lp_probe = probe_stun_binding(
            local_probe_host,
            [lp_port],
            deadline=stun_deadline,
            step_timeout=min(step_timeout, 0.20),
            username=stun_username,
            password=stun_password,
            fingerprint=fingerprint,
        )
        if lp_probe["succeeded"]:
            local_or_control_listener_alive = True
            lp_reflexive: TransportAddress | None = lp_probe["reflexive_address"]  # type: ignore[assignment]
            lp_local: TransportAddress | None = lp_probe["local_address"]  # type: ignore[assignment]
            if reflexive_addr is None:
                reflexive_addr = lp_reflexive
            if local_addr is None:
                local_addr = lp_local

    turn_report: dict[str, object] = {
        "attempted": False,
        "allocated": False,
        "permission_installed": False,
        "loopback_verified": False,
        "deallocated": False,
        "rtt_ms": None,
        "error": None,
    }
    relay_loopback_blocked = False

    if turn_url and turn_username and turn_password is not None:
        try:
            turn_raw = probe_turn_loopback(
                turn_url,
                turn_username,
                turn_password,
                deadline=deadline,
                step_timeout=min(step_timeout, 0.35),
            )
        except (TimeoutError, OSError, StunProtocolError) as exc:
            turn_raw = {
                "host": parse_turn_url(turn_url)[0],
                "port": parse_turn_url(turn_url)[1],
                "allocated": False,
                "permission_installed": False,
                "loopback_verified": False,
                "deallocated": False,
                "rtt_ms": None,
                "local_address": local_addr,
                "reflexive_address": reflexive_addr,
                "relayed_address": None,
                "error": str(exc) or type(exc).__name__,
            }

        if turn_raw["local_address"] is not None:
            local_addr = turn_raw["local_address"]  # type: ignore[assignment]
        if turn_raw["reflexive_address"] is not None:
            reflexive_addr = turn_raw["reflexive_address"]  # type: ignore[assignment]
        if turn_raw["relayed_address"] is not None:
            relayed_addr = turn_raw["relayed_address"]  # type: ignore[assignment]
        if turn_raw["allocated"]:
            local_or_control_listener_alive = True

        if (
            turn_raw["allocated"]
            and turn_raw["permission_installed"]
            and not turn_raw["loopback_verified"]
        ):
            relay_loopback_blocked = True

        turn_report = {
            "attempted": True,
            "host": turn_raw["host"],
            "port": turn_raw["port"],
            "allocated": turn_raw["allocated"],
            "permission_installed": turn_raw["permission_installed"],
            "loopback_verified": turn_raw["loopback_verified"],
            "deallocated": turn_raw["deallocated"],
            "rtt_ms": turn_raw["rtt_ms"],
            "error": redact_secrets(str(turn_raw["error"]), sensitive) if turn_raw["error"] else None,
        }

    shared_public_ip_evidence = (
        bool(domain_ips)
        and local_addr is not None
        and reflexive_addr is not None
        and reflexive_addr.ip in domain_ips
        and local_addr.ip != reflexive_addr.ip
    )
    hairpin_evidence = (
        direct_public_stun_attempted
        and not direct_public_stun_succeeded
        and local_or_control_listener_alive
        and shared_public_ip_evidence
    )

    if turn_url and turn_report["loopback_verified"] and turn_report["deallocated"]:
        status = "turn_relay_verified"
        diagnosis = "TURN UDP allocation, permission grant, 16-byte loopback relay, and Refresh(0) deallocation succeeded."
    elif hairpin_evidence:
        status = "hairpin_nat_blocked"
        diagnosis = "Verified reflexive WAN IP matches KODERA_DOMAIN behind the same NAT, and hairpin UDP traffic via the public IP was dropped."
    elif relay_loopback_blocked:
        status = "relay_loopback_blocked"
        diagnosis = "TURN UDP control allocation and permission succeeded, but relayed Send/Data loopback packets were blocked."
    elif not turn_url and stun_res["succeeded"]:
        status = "ok"
        diagnosis = "RFC 5389 STUN UDP Binding succeeded and returned a valid XOR-MAPPED-ADDRESS."
    else:
        status = "udp_unreachable_or_filtered"
        raw_err = turn_report.get("error") if turn_url else stun_res.get("error")
        clean_err = redact_secrets(str(raw_err or "UDP timeout"), sensitive)
        diagnosis = f"UDP STUN/TURN probe received no valid response ({clean_err})."

    elapsed_ms = round((time.monotonic() - started) * 1000.0, 3)
    stun_summary = {
        "attempted": stun_res["attempted"],
        "succeeded": stun_res["succeeded"],
        "host": stun_res["host"],
        "port": stun_res["port"],
        "rtt_ms": stun_res["rtt_ms"],
        "error": redact_secrets(str(stun_res["error"]), sensitive) if stun_res["error"] else None,
    }

    return {
        "status": status,
        "healthy": status in ("ok", "turn_relay_verified"),
        "elapsed_ms": elapsed_ms,
        "domain": effective_domain,
        "domain_public_ips": domain_ips,
        "local_address": local_addr.to_dict() if local_addr else None,
        "reflexive_address": reflexive_addr.to_dict() if reflexive_addr else None,
        "relayed_address": relayed_addr.to_dict() if relayed_addr else None,
        "stun": stun_summary,
        "turn": turn_report,
        "diagnosis": redact_secrets(diagnosis, sensitive),
        "remediation": _remediation_for(status, stun_ports=selected_ports, domain=effective_domain),
    }


class EphemeralStunTurnServer:
    """In-process ephemeral 127.0.0.1:0 UDP RFC 5389 STUN + RFC 5766 TURN test server."""

    def __init__(
        self,
        *,
        bind_ip: str = "127.0.0.1",
        realm: str = "kodera.selftest",
        nonce: str = "nonce-selftest-7f3a",
        users: dict[str, str] | None = None,
        short_term_password: str | None = None,
        override_mapped_ip: str | None = None,
        override_relayed_ip: str | None = None,
        drop_all: bool = False,
        drop_first_packets: int = 0,
        drop_send_indications: bool = False,
        omit_relayed_attr_on_allocate: bool = False,
        stale_nonce_once_on_refresh: bool = False,
        mismatch_437_on_refresh: bool = False,
        forged_437_on_refresh: bool = False,
        drop_first_refresh_packets: int = 0,
    ) -> None:
        if not bind_ip or ipaddress.ip_address(bind_ip).is_unspecified:
            raise ValueError("EphemeralStunTurnServer requires a concrete loopback or unicast bind_ip")
        self.bind_ip = bind_ip
        self.realm = realm
        self.nonce = nonce
        self.users = users if users is not None else {"turnuser": "turnpass"}
        self.short_term_password = short_term_password
        self.override_mapped_ip = override_mapped_ip
        self.override_relayed_ip = override_relayed_ip
        self.drop_all = drop_all
        self.drop_first_packets = drop_first_packets
        self.drop_send_indications = drop_send_indications
        self.omit_relayed_attr_on_allocate = omit_relayed_attr_on_allocate
        self.stale_nonce_once_on_refresh = stale_nonce_once_on_refresh
        self.mismatch_437_on_refresh = mismatch_437_on_refresh
        self.forged_437_on_refresh = forged_437_on_refresh
        self.drop_first_refresh_packets = drop_first_refresh_packets

        family = socket.AF_INET6 if ":" in bind_ip else socket.AF_INET
        self._family = family
        self._ctrl_sock = socket.socket(family, socket.SOCK_DGRAM)
        self._ctrl_sock.bind((bind_ip, 0))
        self._ctrl_sock.setblocking(False)
        self.port: int = int(self._ctrl_sock.getsockname()[1])

        self._selector = selectors.DefaultSelector()
        self._selector.register(self._ctrl_sock, selectors.EVENT_READ, ("ctrl", None))

        self._allocations: dict[tuple[object, ...], dict[str, object]] = {}
        self.total_allocations = 0
        self.deallocations = 0
        self.refresh_requests = 0
        self.permissions_installed = 0
        self.relayed_packets = 0
        self._dropped_so_far = 0
        self._dropped_refresh_so_far = 0
        self._stale_sent = False

        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._serve, daemon=True)

    @property
    def active_allocations(self) -> int:
        return len(self._allocations)

    def start(self) -> Self:
        self._thread.start()
        return self

    def close(self) -> None:
        self._stop.set()
        self._thread.join(timeout=1.0)
        for state in list(self._allocations.values()):
            relay_sock: socket.socket = state["relay_sock"]  # type: ignore[assignment]
            with contextlib.suppress(KeyError, ValueError, OSError):
                self._selector.unregister(relay_sock)
            relay_sock.close()
        self._allocations.clear()
        with contextlib.suppress(KeyError, ValueError, OSError):
            self._selector.unregister(self._ctrl_sock)
        self._selector.close()
        self._ctrl_sock.close()

    def __enter__(self) -> Self:
        return self.start()

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def _serve(self) -> None:
        while not self._stop.is_set():
            events = self._selector.select(timeout=0.015)
            for key, _mask in events:
                kind, client_addr = key.data
                if kind == "ctrl":
                    self._handle_ctrl()
                elif kind == "relay":
                    self._handle_relay(key.fileobj, client_addr)  # type: ignore[arg-type]

    def _handle_relay(self, relay_sock: socket.socket, client_addr: tuple[object, ...]) -> None:
        try:
            payload, peer_addr = relay_sock.recvfrom(4096)
        except OSError:
            return
        state = self._allocations.get(client_addr)
        if state is None:
            return
        perms: set[str] = state["permissions"]  # type: ignore[assignment]
        peer_ip = str(ipaddress.ip_address(str(peer_addr[0]).split("%", 1)[0]))
        if peer_ip not in perms:
            return
        ind_txid = secrets.token_bytes(12)
        ind_attrs = (
            (ATTR_XOR_PEER_ADDRESS, encode_xor_address(peer_ip, int(peer_addr[1]), ind_txid)),
            (ATTR_DATA, payload),
        )
        pkt, _ = build_stun_message(
            MSG_DATA_INDICATION,
            txid=ind_txid,
            attributes=ind_attrs,
            fingerprint=True,
        )
        with contextlib.suppress(OSError):
            self._ctrl_sock.sendto(pkt, client_addr)
            self.relayed_packets += 1

    def _handle_ctrl(self) -> None:
        try:
            raw, client_addr = self._ctrl_sock.recvfrom(4096)
        except OSError:
            return
        if self.drop_all:
            return
        if self._dropped_so_far < self.drop_first_packets:
            self._dropped_so_far += 1
            return
        try:
            msg = parse_stun_message(raw)
        except StunProtocolError:
            return

        client_ip = str(ipaddress.ip_address(str(client_addr[0]).split("%", 1)[0]))
        client_port = int(client_addr[1])
        mapped_ip = self.override_mapped_ip or client_ip

        if msg.msg_type == MSG_BINDING_REQUEST:
            key: bytes | None = None
            if self.short_term_password is not None:
                key = derive_short_term_key(self.short_term_password)
                try:
                    parse_stun_message(raw, integrity_key=key, require_fingerprint=True)
                except StunProtocolError:
                    err_pkt, _ = build_stun_message(
                        MSG_BINDING_ERROR,
                        txid=msg.txid,
                        attributes=((ATTR_ERROR_CODE, encode_error_code(401, "Unauthorized")),),
                        fingerprint=True,
                    )
                    self._ctrl_sock.sendto(err_pkt, client_addr)
                    return
            resp_pkt, _ = build_stun_message(
                MSG_BINDING_SUCCESS,
                txid=msg.txid,
                attributes=(
                    (ATTR_XOR_MAPPED_ADDRESS, encode_xor_address(mapped_ip, client_port, msg.txid)),
                ),
                integrity_key=key,
                fingerprint=True,
            )
            self._ctrl_sock.sendto(resp_pkt, client_addr)
            return

        if msg.msg_type == MSG_SEND_INDICATION:
            if self.drop_send_indications:
                return
            state = self._allocations.get(client_addr)
            if state is None:
                return
            peer_raw = msg.first_attr(ATTR_XOR_PEER_ADDRESS)
            data_raw = msg.first_attr(ATTR_DATA)
            if peer_raw is None or data_raw is None:
                return
            peer = decode_xor_address(peer_raw, msg.txid)
            perms = state["permissions"]  # type: ignore[assignment]
            if peer.ip not in perms:
                return
            relay_sock: socket.socket = state["relay_sock"]  # type: ignore[assignment]
            with contextlib.suppress(OSError):
                relay_sock.sendto(data_raw, (peer.ip, peer.port))
            return

        user_raw = msg.first_attr(ATTR_USERNAME)
        realm_raw = msg.first_attr(ATTR_REALM)
        nonce_raw = msg.first_attr(ATTR_NONCE)
        mi_raw = msg.first_attr(ATTR_MESSAGE_INTEGRITY)

        err_type = {
            MSG_ALLOCATE_REQUEST: MSG_ALLOCATE_ERROR,
            MSG_CREATE_PERMISSION_REQUEST: MSG_CREATE_PERMISSION_ERROR,
            MSG_REFRESH_REQUEST: MSG_REFRESH_ERROR,
        }.get(msg.msg_type)
        if err_type is None:
            return

        if not user_raw or not realm_raw or not nonce_raw or not mi_raw:
            challenge, _ = build_stun_message(
                err_type,
                txid=msg.txid,
                attributes=(
                    (ATTR_ERROR_CODE, encode_error_code(401, "Unauthorized")),
                    (ATTR_REALM, self.realm.encode()),
                    (ATTR_NONCE, self.nonce.encode()),
                ),
                fingerprint=True,
            )
            self._ctrl_sock.sendto(challenge, client_addr)
            return

        if msg.msg_type == MSG_REFRESH_REQUEST and self._dropped_refresh_so_far < self.drop_first_refresh_packets:
            self._dropped_refresh_so_far += 1
            return

        if msg.msg_type == MSG_REFRESH_REQUEST and self.forged_437_on_refresh:
            forged, _ = build_stun_message(
                MSG_REFRESH_ERROR,
                txid=msg.txid,
                attributes=((ATTR_ERROR_CODE, encode_error_code(437, "Forged Mismatch")),),
                integrity_key=b"wrong-attacker-integrity-key",
                fingerprint=True,
            )
            self._ctrl_sock.sendto(forged, client_addr)
            return

        if msg.msg_type == MSG_REFRESH_REQUEST and self.stale_nonce_once_on_refresh and not self._stale_sent:
            self._stale_sent = True
            self.nonce = "nonce-rotated-8899"
            stale, _ = build_stun_message(
                MSG_REFRESH_ERROR,
                txid=msg.txid,
                attributes=(
                    (ATTR_ERROR_CODE, encode_error_code(438, "Stale Nonce")),
                    (ATTR_REALM, self.realm.encode()),
                    (ATTR_NONCE, self.nonce.encode()),
                ),
                fingerprint=True,
            )
            self._ctrl_sock.sendto(stale, client_addr)
            return

        username = saslprep(user_raw.decode("utf-8", "replace"))
        realm_str = realm_raw.decode("utf-8", "replace")
        nonce_str = nonce_raw.decode("utf-8", "replace")
        password = None
        for cfg_user, cfg_pw in self.users.items():
            if saslprep(cfg_user) == username:
                password = cfg_pw
                break
        if password is None or realm_str != self.realm or nonce_str != self.nonce:
            unauthorized, _ = build_stun_message(
                err_type,
                txid=msg.txid,
                attributes=(
                    (ATTR_ERROR_CODE, encode_error_code(401, "Unauthorized")),
                    (ATTR_REALM, self.realm.encode()),
                    (ATTR_NONCE, self.nonce.encode()),
                ),
                fingerprint=True,
            )
            self._ctrl_sock.sendto(unauthorized, client_addr)
            return

        lt_key = derive_long_term_key(username, self.realm, password)
        try:
            parse_stun_message(raw, integrity_key=lt_key)
        except StunProtocolError:
            unauthorized, _ = build_stun_message(
                err_type,
                txid=msg.txid,
                attributes=(
                    (ATTR_ERROR_CODE, encode_error_code(401, "Bad Integrity")),
                    (ATTR_REALM, self.realm.encode()),
                    (ATTR_NONCE, self.nonce.encode()),
                ),
                fingerprint=True,
            )
            self._ctrl_sock.sendto(unauthorized, client_addr)
            return

        if msg.msg_type == MSG_ALLOCATE_REQUEST:
            req_transport = msg.first_attr(ATTR_REQUESTED_TRANSPORT)
            if req_transport is None or len(req_transport) < 1 or req_transport[0] != TRANSPORT_UDP:
                bad_req, _ = build_stun_message(
                    MSG_ALLOCATE_ERROR,
                    txid=msg.txid,
                    attributes=((ATTR_ERROR_CODE, encode_error_code(400, "Unsupported Transport")),),
                    integrity_key=lt_key,
                    fingerprint=True,
                )
                self._ctrl_sock.sendto(bad_req, client_addr)
                return

            relay_sock = socket.socket(self._family, socket.SOCK_DGRAM)
            relay_sock.bind((self.bind_ip, 0))
            relay_sock.setblocking(False)
            relay_bound = relay_sock.getsockname()
            relay_ip = self.override_relayed_ip or str(
                ipaddress.ip_address(str(relay_bound[0]).split("%", 1)[0])
            )
            relay_port = int(relay_bound[1])

            self._allocations[client_addr] = {
                "relay_sock": relay_sock,
                "permissions": set(),
            }
            self._selector.register(relay_sock, selectors.EVENT_READ, ("relay", client_addr))
            self.total_allocations += 1

            alloc_attrs: list[tuple[int, bytes]] = [
                (ATTR_XOR_MAPPED_ADDRESS, encode_xor_address(mapped_ip, client_port, msg.txid)),
                (ATTR_LIFETIME, struct.pack(">I", 600)),
            ]
            if not self.omit_relayed_attr_on_allocate:
                alloc_attrs.insert(
                    0, (ATTR_XOR_RELAYED_ADDRESS, encode_xor_address(relay_ip, relay_port, msg.txid))
                )

            ok_pkt, _ = build_stun_message(
                MSG_ALLOCATE_SUCCESS,
                txid=msg.txid,
                attributes=alloc_attrs,
                integrity_key=lt_key,
                fingerprint=True,
            )
            self._ctrl_sock.sendto(ok_pkt, client_addr)
            return

        if msg.msg_type == MSG_CREATE_PERMISSION_REQUEST:
            state = self._allocations.get(client_addr)
            if state is None:
                mismatch, _ = build_stun_message(
                    MSG_CREATE_PERMISSION_ERROR,
                    txid=msg.txid,
                    attributes=((ATTR_ERROR_CODE, encode_error_code(437, "Allocation Mismatch")),),
                    integrity_key=lt_key,
                    fingerprint=True,
                )
                self._ctrl_sock.sendto(mismatch, client_addr)
                return
            peer_raw = msg.first_attr(ATTR_XOR_PEER_ADDRESS)
            if peer_raw is not None:
                peer = decode_xor_address(peer_raw, msg.txid)
                perms: set[str] = state["permissions"]  # type: ignore[assignment]
                perms.add(peer.ip)
                self.permissions_installed += 1
            ok_pkt, _ = build_stun_message(
                MSG_CREATE_PERMISSION_SUCCESS,
                txid=msg.txid,
                integrity_key=lt_key,
                fingerprint=True,
            )
            self._ctrl_sock.sendto(ok_pkt, client_addr)
            return

        if msg.msg_type == MSG_REFRESH_REQUEST:
            self.refresh_requests += 1
            state = self._allocations.get(client_addr)
            lifetime_raw = msg.first_attr(ATTR_LIFETIME)
            lifetime = struct.unpack(">I", lifetime_raw)[0] if (lifetime_raw and len(lifetime_raw) == 4) else 600
            if lifetime == 0 and state is not None:
                relay_sock = state["relay_sock"]  # type: ignore[assignment]
                with contextlib.suppress(KeyError, ValueError, OSError):
                    self._selector.unregister(relay_sock)
                relay_sock.close()
                del self._allocations[client_addr]
                self.deallocations += 1
            if self.mismatch_437_on_refresh:
                mismatch, _ = build_stun_message(
                    MSG_REFRESH_ERROR,
                    txid=msg.txid,
                    attributes=((ATTR_ERROR_CODE, encode_error_code(437, "Allocation Mismatch")),),
                    integrity_key=lt_key,
                    fingerprint=True,
                )
                self._ctrl_sock.sendto(mismatch, client_addr)
                return
            ok_pkt, _ = build_stun_message(
                MSG_REFRESH_SUCCESS,
                txid=msg.txid,
                attributes=((ATTR_LIFETIME, struct.pack(">I", lifetime)),),
                integrity_key=lt_key,
                fingerprint=True,
            )
            self._ctrl_sock.sendto(ok_pkt, client_addr)


def selftest() -> int:
    """Verify STUN/TURN wire framing, SASLprep, post-MI filtering, RTO, and all classifications."""
    started = time.monotonic()

    # 1. IPv4 & IPv6 XOR-MAPPED-ADDRESS + post-MESSAGE-INTEGRITY attribute ignore + SASLprep.
    tx = bytes.fromhex("00112233445566778899aabb")
    assert decode_xor_address(encode_xor_address("203.0.113.42", 3478, tx), tx) == TransportAddress(
        "203.0.113.42", 3478, "IPv4"
    )
    assert decode_xor_address(
        encode_xor_address("2001:db8::abcd:1", 50123, tx), tx
    ) == TransportAddress("2001:db8::abcd:1", 50123, "IPv6")

    assert saslprep("\U0002f868") == "\U0002136a"
    assert derive_long_term_key("u\u00adsr", "r", "p\u00a0w") == derive_long_term_key(
        "usr", "r", "p w"
    )

    signed_pkt, signed_tx = build_stun_message(
        MSG_BINDING_SUCCESS,
        attributes=((ATTR_XOR_MAPPED_ADDRESS, encode_xor_address("198.51.100.10", 3478, tx)),),
        txid=tx,
        integrity_key=b"ice-pwd-selftest",
    )
    # Append unauthenticated attribute after MESSAGE-INTEGRITY: must be ignored per RFC 5389 §15.4.
    injected_tail = encode_attr(ATTR_USERNAME, b"forged")
    new_len = (len(signed_pkt) - 20) + len(injected_tail)
    augmented = STUN_HEADER_STRUCT.pack(MSG_BINDING_SUCCESS, new_len, STUN_MAGIC_COOKIE, signed_tx) + signed_pkt[20:] + injected_tail
    parsed_aug = parse_stun_message(augmented, expected_txid=signed_tx, integrity_key=b"ice-pwd-selftest")
    assert parsed_aug.first_attr(ATTR_USERNAME) is None

    # 2. Real UDP STUN Binding with single packet drop recovered via RTO (`status == "ok"`).
    with EphemeralStunTurnServer(drop_first_packets=1) as srv:
        res_ok = run_probe(stun_host="127.0.0.1", stun_port=srv.port, timeout_budget=0.8)
        assert res_ok["status"] == "ok", res_ok

    # 3. Real UDP TURN 401 -> Allocate -> CreatePermission -> Send/Data -> Refresh(0) w/ RTO + 438 retry.
    dyn_cred = "turn-" + secrets.token_hex(8)
    with EphemeralStunTurnServer(
        users={"alice": dyn_cred},
        stale_nonce_once_on_refresh=True,
        drop_first_refresh_packets=1,
    ) as srv:
        res_turn = run_probe(
            stun_host="127.0.0.1",
            stun_port=srv.port,
            turn_url=f"turn:127.0.0.1:{srv.port}?transport=udp",
            turn_username="alice",
            turn_password=dyn_cred,
            timeout_budget=1.2,
        )
        assert res_turn["status"] == "turn_relay_verified", res_turn
        assert res_turn["turn"]["deallocated"] is True  # type: ignore[index]
        assert srv.deallocations == 1 and srv.active_allocations == 0
        assert dyn_cred not in json.dumps(res_turn)

    # 4. Evidence-backed Hairpin NAT vs relay_loopback_blocked vs udp_unreachable_or_filtered.
    with (
        EphemeralStunTurnServer(override_mapped_ip="203.0.113.77") as ok_srv,
        EphemeralStunTurnServer(drop_all=True) as blackhole_srv,
    ):
        res_hp = run_probe(
            stun_host="127.0.0.1",
            stun_port=ok_srv.port,
            domain="chat.example.org",
            public_ips=["203.0.113.77"],
            hairpin_host="127.0.0.1",
            hairpin_port=blackhole_srv.port,
            timeout_budget=0.6,
            step_timeout=0.08,
        )
        assert res_hp["status"] == "hairpin_nat_blocked", res_hp

        res_unreach = run_probe(
            stun_host="127.0.0.1",
            stun_port=blackhole_srv.port,
            timeout_budget=0.35,
            step_timeout=0.08,
        )
        assert res_unreach["status"] == "udp_unreachable_or_filtered", res_unreach

    elapsed = time.monotonic() - started
    assert elapsed < MAX_DEFAULT_BUDGET_SECONDS, f"selftest exceeded budget: {elapsed:.3f}s"
    print(
        f"OK: webrtc_probe selftest passed (RFC 5389/5766 wire framing, SASLprep, post-MI filter, "
        f"RTO retransmission, TURN 401->Allocate->CreatePermission->Send/Data->Refresh(0), "
        f"hairpin NAT, and UDP blackhole verified in {elapsed * 1000.0:.1f} ms)."
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="webrtc_probe.py",
        description="Headless RFC 5389 STUN & RFC 5766 TURN UDP diagnostic probe for Kodera.",
    )
    parser.add_argument("--env-file", type=Path, help="Optional operator .env file for domain/TURN defaults")
    parser.add_argument("--domain", help="Public KODERA_DOMAIN hostname")
    parser.add_argument(
        "--public-ip",
        action="append",
        dest="public_ips",
        help="Expected public IP for KODERA_DOMAIN (repeatable; skips DNS when provided)",
    )
    parser.add_argument("--stun-host", help="STUN / TURN UDP host (defaults to TURN_DOMAIN, KODERA_DOMAIN, or 127.0.0.1)")
    parser.add_argument("--stun-port", type=int, help=f"Explicit STUN UDP port (default: {DEFAULT_STUN_PORT})")
    parser.add_argument(
        "--ports",
        help=f"Comma-separated UDP ports or start-end ranges (default: {DEFAULT_STUN_PORT})",
    )
    parser.add_argument("--port-range-start", type=int, default=None)
    parser.add_argument("--port-range-end", type=int, default=None)
    parser.add_argument("--max-ports", type=int, default=DEFAULT_MAX_PORT_SAMPLES)
    parser.add_argument("--stun-username", help="Optional STUN short-term USERNAME (ufrag)")
    parser.add_argument(
        "--stun-password-env",
        help="Environment variable holding STUN short-term password",
    )
    parser.add_argument("--fingerprint", action="store_true", help="Attach RFC 5389 CRC-32 FINGERPRINT")
    parser.add_argument("--turn-url", help="Optional RFC 5766 TURN UDP URL (e.g. turn:turn.example.org:3478)")
    parser.add_argument("--turn-username", help="TURN long-term credential username")
    parser.add_argument(
        "--turn-password-env",
        default="KODERA_TURN_PASSWORD",
        help="Environment variable holding TURN password (default: KODERA_TURN_PASSWORD or TURN_PASSWORD)",
    )
    parser.add_argument("--local-probe-host", help="Optional auxiliary STUN host for shared-NAT comparison")
    parser.add_argument("--local-probe-port", type=int, help="Optional auxiliary STUN UDP port")
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_BUDGET_SECONDS,
        help=f"Total probe budget in seconds (default: {DEFAULT_BUDGET_SECONDS}, max 2.5)",
    )
    parser.add_argument("--json", action="store_true", help="Emit deterministic JSON report")
    parser.add_argument("--selftest", action="store_true", help="Run real-socket protocol self-test")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.selftest:
        return selftest()

    env_map: dict[str, str] = {}
    secrets_set: set[str] = set()
    try:
        if not math.isfinite(args.timeout) or args.timeout <= 0:
            raise ValueError("--timeout must be a positive finite number")
        if args.env_file is not None:
            env_map, secrets_set = read_env_file_safe(args.env_file)

        stun_password = os.environ.get(args.stun_password_env) if args.stun_password_env else None
        if stun_password:
            secrets_set.add(stun_password)

        env_turn_domain = env_map.get("TURN_DOMAIN") or env_map.get("KODERA_TURN_DOMAIN") or os.environ.get("TURN_DOMAIN")
        env_turn_port_raw = (
            env_map.get("TURN_UDP_PORT")
            or env_map.get("KODERA_TURN_UDP_PORT")
            or os.environ.get("TURN_UDP_PORT")
        )
        env_turn_port = int(env_turn_port_raw) if (env_turn_port_raw and env_turn_port_raw.isdigit()) else DEFAULT_TURN_PORT

        turn_username = (
            args.turn_username
            or env_map.get("TURN_USERNAME")
            or env_map.get("KODERA_TURN_USERNAME")
            or os.environ.get("TURN_USERNAME")
            or os.environ.get("KODERA_TURN_USERNAME")
        )
        turn_password = (
            os.environ.get(args.turn_password_env)
            or env_map.get(args.turn_password_env)
            or os.environ.get("TURN_PASSWORD")
            or env_map.get("TURN_PASSWORD")
            or env_map.get("KODERA_TURN_PASSWORD")
        )
        if turn_password:
            secrets_set.add(turn_password)

        turn_url = (
            args.turn_url
            or env_map.get("KODERA_TURN_URL")
            or env_map.get("TURN_URL")
            or os.environ.get("KODERA_TURN_URL")
            or os.environ.get("TURN_URL")
        )
        if not turn_url and env_turn_domain and turn_username and turn_password is not None:
            turn_url = f"turn:{env_turn_domain}:{env_turn_port}?transport=udp"

        domain = args.domain or env_map.get("KODERA_DOMAIN") or os.environ.get("KODERA_DOMAIN")
        parsed_ports = parse_ports_spec(args.ports, max_ports=args.max_ports) if args.ports else None
        eff_stun_port = args.stun_port
        if eff_stun_port is None and parsed_ports is None and args.port_range_start is None and env_turn_port_raw:
            eff_stun_port = env_turn_port
        eff_stun_host = args.stun_host or env_turn_domain

        budget = min(args.timeout, MAX_DEFAULT_BUDGET_SECONDS)

        report = run_probe(
            stun_host=eff_stun_host,
            stun_port=eff_stun_port,
            ports=parsed_ports,
            port_range_start=args.port_range_start,
            port_range_end=args.port_range_end,
            max_ports=args.max_ports,
            stun_username=args.stun_username,
            stun_password=stun_password,
            fingerprint=args.fingerprint,
            turn_url=turn_url,
            turn_username=turn_username,
            turn_password=turn_password,
            domain=domain,
            public_ips=args.public_ips,
            local_probe_host=args.local_probe_host,
            local_probe_port=args.local_probe_port,
            timeout_budget=budget,
            extra_secrets=secrets_set,
        )
    except (ValueError, OSError, StunProtocolError) as exc:
        safe_msg = redact_secrets(str(exc), secrets_set)
        if args.json:
            print(
                json.dumps(
                    {
                        "status": "error",
                        "healthy": False,
                        "diagnosis": safe_msg,
                        "remediation": [],
                    },
                    sort_keys=True,
                )
            )
        else:
            print(f"[FAIL] WebRTC probe refused: {safe_msg}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(report, sort_keys=True))
    else:
        badge = "OK" if report["healthy"] else "FAIL"
        print(f"[{badge}] status={report['status']} ({report['elapsed_ms']} ms): {report['diagnosis']}")
        for step in report["remediation"]:  # type: ignore[union-attr]
            print(f"  - {step}")
    return 0 if report["healthy"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
