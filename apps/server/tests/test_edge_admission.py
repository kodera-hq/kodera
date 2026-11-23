"""Unit and protocol integration tests for `config.edge_admission` (`kodera#254`)."""

from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import json
import time
from collections.abc import AsyncIterator

import pytest

from config.edge_admission import (
    BODY_MAX_BYTES,
    DEFAULT_GLOBAL_BODY_SLOTS,
    DEFAULT_MAX_GLOBAL_BODY_BYTES,
    STREAM_READER_LIMIT,
    AdmissionConfig,
    BurstTokenBucket,
    EdgeAdmissionServer,
    _meta_from_headers,
    _ProtocolRefusalError,
    build_config,
    normalize_client_bucket,
)


class _RecordingUpstream:
    """Minimal HTTP/1.1 upstream recorder counting exact socket accepts and payloads."""

    def __init__(self) -> None:
        self.connect_count = 0
        self.requests: list[tuple[str, str, dict[str, str], bytes]] = []
        self._server: asyncio.AbstractServer | None = None
        self.port = 0

    async def start(self) -> None:
        self._server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        sockets = self._server.sockets or ()
        self.port = int(sockets[0].getsockname()[1])

    async def close(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.connect_count += 1
        try:
            buf = bytearray()
            while b"\r\n\r\n" not in buf:
                chunk = await reader.read(8192)
                if not chunk:
                    return
                buf.extend(chunk)
            idx = buf.index(b"\r\n\r\n")
            raw_head = bytes(buf[:idx]).decode("latin-1")
            body = bytearray(buf[idx + 4 :])
            lines = raw_head.split("\r\n")
            method, target, _ = lines[0].split(" ", 2)
            headers: dict[str, str] = {}
            for line in lines[1:]:
                name, _, val = line.partition(":")
                headers[name.strip().lower()] = val.strip()
            length = int(headers.get("content-length", "0"))
            while len(body) < length:
                more = await reader.read(min(65536, length - len(body)))
                if not more:
                    break
                body.extend(more)
            payload = bytes(body[:length])
            self.requests.append((method, target, headers, payload))
            resp_body = json.dumps({"ok": True, "bytes": len(payload)}).encode("utf-8")
            writer.write(
                b"HTTP/1.1 200 OK\r\n"
                b"Content-Type: application/json\r\n"
                + f"Content-Length: {len(resp_body)}\r\n".encode("ascii")
                + b"Connection: close\r\n\r\n"
                + resp_body
            )
            await writer.drain()
        finally:
            with contextlib.suppress(OSError):
                writer.close()
                await writer.wait_closed()


@contextlib.asynccontextmanager
async def _running_pair(**overrides: object) -> AsyncIterator[tuple[int, _RecordingUpstream]]:
    upstream = _RecordingUpstream()
    await upstream.start()
    defaults: dict[str, object] = {
        "listen_host": "127.0.0.1",
        "listen_port": 0,
        "upstream_host": "127.0.0.1",
        "upstream_port": upstream.port,
        "trusted_edges": (ipaddress.ip_network("127.0.0.1/32"),),
        "require_trusted_edge": True,
    }
    defaults.update(overrides)
    config = AdmissionConfig(**defaults)  # type: ignore[arg-type]
    proxy = EdgeAdmissionServer(config)
    _, bound_port = await proxy.start()
    try:
        yield bound_port, upstream
    finally:
        await proxy.close()
        await upstream.close()


async def _raw_exchange(
    port: int, payload: bytes, *, timeout: float = 5.0
) -> tuple[int, dict[str, str], bytes]:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    try:
        writer.write(payload)
        await writer.drain()
        raw = await asyncio.wait_for(reader.read(), timeout=timeout)
    finally:
        with contextlib.suppress(OSError):
            writer.close()
            await writer.wait_closed()
    head_bytes, _, body = raw.partition(b"\r\n\r\n")
    lines = head_bytes.decode("latin-1").split("\r\n")
    status = int(lines[0].split(" ", 2)[1])
    headers: dict[str, str] = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    return status, headers, body


def test_buffers_full_request_body_before_opening_upstream_connection() -> None:
    async def scenario() -> None:
        async with _running_pair() as (port, upstream):
            reader, writer = await asyncio.open_connection("127.0.0.1", port)
            try:
                writer.write(
                    b"POST /api/v1/items HTTP/1.1\r\n"
                    b"Host: localhost\r\n"
                    b"X-Forwarded-For: 198.51.100.10\r\n"
                    b"Content-Length: 10\r\n\r\n"
                    b"hello"
                )
                await writer.drain()
                await asyncio.sleep(0.12)
                # Upstream socket MUST NOT open while client body is still in flight.
                assert upstream.connect_count == 0

                writer.write(b"world")
                await writer.drain()
                raw = await asyncio.wait_for(reader.read(), timeout=3.0)
            finally:
                writer.close()
                await writer.wait_closed()

            assert raw.startswith(b"HTTP/1.1 200 OK\r\n")
            assert upstream.connect_count == 1
            assert len(upstream.requests) == 1
            method, target, headers, body = upstream.requests[0]
            assert (method, target, body) == ("POST", "/api/v1/items", b"helloworld")
            assert headers["content-length"] == "10"

    asyncio.run(scenario())


def test_exact_1mib_accepted_and_oversized_fixed_or_chunked_refused_without_upstream_connect() -> (
    None
):
    async def scenario() -> None:
        async with _running_pair() as (port, upstream):
            exact = b"a" * BODY_MAX_BYTES
            status, _, _ = await _raw_exchange(
                port,
                f"POST /api/v1/exact HTTP/1.1\r\nHost: localhost\r\nContent-Length: {len(exact)}\r\n\r\n".encode(
                    "ascii"
                )
                + exact,
            )
            assert status == 200
            assert upstream.connect_count == 1

            oversized_len = BODY_MAX_BYTES + 1
            status_over, hdrs_over, _ = await _raw_exchange(
                port,
                f"POST /api/v1/over HTTP/1.1\r\nHost: localhost\r\nContent-Length: {oversized_len}\r\n\r\n1234".encode(
                    "ascii"
                ),
            )
            assert status_over == 413
            assert hdrs_over["connection"] == "close"
            assert upstream.connect_count == 1

            # Chunked <= 1 MiB is decoded and forwarded with a normalized Content-Length.
            chunk_unit = b"b" * 262_144
            chunked_wire = bytearray(
                b"POST /api/v1/chunked HTTP/1.1\r\n"
                b"Host: localhost\r\n"
                b"Transfer-Encoding: chunked\r\n\r\n"
            )
            for _ in range(4):
                chunked_wire.extend(f"{len(chunk_unit):x}\r\n".encode("ascii"))
                chunked_wire.extend(chunk_unit)
                chunked_wire.extend(b"\r\n")
            chunked_wire.extend(b"0\r\n\r\n")
            status_chunked, _, _ = await _raw_exchange(port, bytes(chunked_wire))
            assert status_chunked == 200
            assert upstream.connect_count == 2
            _, _, up_headers, up_body = upstream.requests[-1]
            assert len(up_body) == BODY_MAX_BYTES
            assert up_headers["content-length"] == str(BODY_MAX_BYTES)
            assert "transfer-encoding" not in up_headers

            # Chunked > 1 MiB is refused with 413 before opening any upstream socket.
            over_chunked = (
                b"POST /api/v1/chunked-over HTTP/1.1\r\n"
                b"Host: localhost\r\n"
                b"Transfer-Encoding: chunked\r\n\r\n"
                + f"{BODY_MAX_BYTES + 1:x}\r\n".encode("ascii")
                + b"x" * 1024
            )
            status_chunked_over, _, _ = await _raw_exchange(port, over_chunked)
            assert status_chunked_over == 413
            assert upstream.connect_count == 2

    asyncio.run(scenario())


def test_slow_trickle_writer_hits_deadline_408_without_opening_upstream_connection() -> None:
    async def scenario() -> None:
        async with _running_pair(body_read_seconds=0.2) as (port, upstream):
            reader, writer = await asyncio.open_connection("127.0.0.1", port)
            try:
                writer.write(
                    b"POST /api/v1/slow HTTP/1.1\r\n"
                    b"Host: localhost\r\n"
                    b"Content-Length: 65536\r\n\r\n"
                    b"trickle"
                )
                await writer.drain()
                raw = await asyncio.wait_for(reader.read(), timeout=2.0)
            finally:
                writer.close()
                await writer.wait_closed()

            assert raw.startswith(b"HTTP/1.1 408 Request Timeout\r\n")
            assert b"Connection: close\r\n" in raw
            assert upstream.connect_count == 0

            # Chunked slow trickle also hits the wall-clock deadline with zero upstream connects.
            reader2, writer2 = await asyncio.open_connection("127.0.0.1", port)
            try:
                writer2.write(
                    b"POST /api/v1/slow-chunked HTTP/1.1\r\n"
                    b"Host: localhost\r\n"
                    b"Transfer-Encoding: chunked\r\n\r\n"
                    b"4\r\nabcd\r\n"
                )
                await writer2.drain()
                raw2 = await asyncio.wait_for(reader2.read(), timeout=2.0)
            finally:
                writer2.close()
                await writer2.wait_closed()

            assert raw2.startswith(b"HTTP/1.1 408 Request Timeout\r\n")
            assert upstream.connect_count == 0

    asyncio.run(scenario())


def test_http_smuggling_and_expect_continue_handling() -> None:
    async def scenario() -> None:
        async with _running_pair() as (port, upstream):
            smuggle_payloads = [
                # CL + TE ambiguity
                b"POST /api/v1/x HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
                # Conflicting duplicate Content-Length
                b"POST /api/v1/x HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\nContent-Length: 5\r\n\r\nabcd",
                # Identical duplicate Content-Length (`4` + `4`)
                b"POST /api/v1/x HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\nContent-Length: 4\r\n\r\nabcd",
                # Leading-zero duplicate Content-Length (`4` + `04`)
                b"POST /api/v1/x HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\nContent-Length: 04\r\n\r\nabcd",
                # Duplicate Host header
                b"GET /health/live HTTP/1.1\r\nHost: a.example\r\nHost: b.example\r\n\r\n",
                # Obsolete header line folding
                b"GET /health/live HTTP/1.1\r\nHost: localhost\r\n X-Folded: 1\r\n\r\n",
                # Unsupported Transfer-Encoding
                b"POST /api/v1/x HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: gzip, chunked\r\n\r\n",
            ]
            for bad in smuggle_payloads:
                status, _, _ = await _raw_exchange(port, bad)
                assert status == 400
            assert upstream.connect_count == 0

            status_trace, _, _ = await _raw_exchange(
                port, b"TRACE / HTTP/1.1\r\nHost: localhost\r\n\r\n"
            )
            assert status_trace == 405
            assert upstream.connect_count == 0

            # Oversized Expect: 100-continue is rejected with 413 without sending 100 Continue.
            status_exp_over, _, _ = await _raw_exchange(
                port,
                f"POST /api/v1/exp HTTP/1.1\r\nHost: localhost\r\nExpect: 100-continue\r\nContent-Length: {BODY_MAX_BYTES + 1}\r\n\r\n".encode(
                    "ascii"
                ),
            )
            assert status_exp_over == 413
            assert upstream.connect_count == 0

            # Admitted Expect: 100-continue receives 100 Continue, buffers body, and returns 200 OK.
            reader, writer = await asyncio.open_connection("127.0.0.1", port)
            try:
                writer.write(
                    b"POST /api/v1/exp-ok HTTP/1.1\r\n"
                    b"Host: localhost\r\n"
                    b"Expect: 100-continue\r\n"
                    b"Content-Length: 6\r\n\r\n"
                )
                await writer.drain()
                interim = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=2.0)
                assert interim == b"HTTP/1.1 100 Continue\r\n\r\n"
                assert upstream.connect_count == 0
                writer.write(b"okbody")
                await writer.drain()
                final = await asyncio.wait_for(reader.read(), timeout=2.0)
                assert final.startswith(b"HTTP/1.1 200 OK\r\n")
                assert upstream.connect_count == 1
            finally:
                writer.close()
                await writer.wait_closed()

    asyncio.run(scenario())


def test_require_trusted_edge_refuses_untrusted_peer_while_allowing_loopback_liveness() -> None:
    async def scenario() -> None:
        # Only 172.30.240.2/32 is trusted, so 127.0.0.1 is an untrusted peer for proxied traffic,
        # while loopback `/_admission/live` remains reachable for the container healthcheck.
        async with _running_pair(
            trusted_edges=(ipaddress.ip_network("172.30.240.2/32"),),
            require_trusted_edge=True,
        ) as (port, upstream):
            live_status, _, live_body = await _raw_exchange(
                port, b"GET /_admission/live HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"
            )
            assert live_status == 200
            assert json.loads(live_body) == {"status": "alive"}

            proxy_status, _, _ = await _raw_exchange(
                port, b"GET /health/live HTTP/1.1\r\nHost: localhost\r\n\r\n"
            )
            assert proxy_status == 403
            assert upstream.connect_count == 0

    asyncio.run(scenario())


def test_fair_per_ip_slow_body_cap_protects_global_slots_shared_nat_bursts_and_reads() -> None:
    async def scenario() -> None:
        async with _running_pair(
            global_body_slots=24,
            per_ip_body_slots=3,
            per_ip_queue_wait_seconds=0.1,
            body_read_seconds=0.55,
        ) as (port, upstream):

            async def open_slow() -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
                r, w = await asyncio.open_connection("127.0.0.1", port)
                w.write(
                    b"POST /api/v1/attacker-slow HTTP/1.1\r\n"
                    b"Host: localhost\r\n"
                    b"X-Forwarded-For: 198.51.100.50\r\n"
                    b"Content-Length: 65536\r\n\r\n"
                    b"slow"
                )
                await w.drain()
                return r, w

            slow_conns = await asyncio.gather(*(open_slow() for _ in range(6)))
            try:
                await asyncio.sleep(0.18)

                # Shared-NAT IP 203.0.113.88 fires 16 concurrent fast writes while attacker holds its 3 slots.
                async def fast_write(idx: int) -> int:
                    body = f"payload-{idx:02d}".encode("ascii")
                    status, _, _ = await _raw_exchange(
                        port,
                        f"POST /api/v1/nat-fast HTTP/1.1\r\n"
                        f"Host: localhost\r\n"
                        f"X-Forwarded-For: 203.0.113.88\r\n"
                        f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
                        + body,
                    )
                    return status

                async def fast_read() -> int:
                    status, _, _ = await _raw_exchange(
                        port,
                        b"GET /health/live HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: 203.0.113.9\r\n\r\n",
                    )
                    return status

                write_statuses, read_statuses = await asyncio.gather(
                    asyncio.gather(*(fast_write(i) for i in range(16))),
                    asyncio.gather(*(fast_read() for _ in range(12))),
                )
                assert write_statuses == [200] * 16
                assert read_statuses == [200] * 12

                slow_statuses: list[int] = []
                for r, _ in slow_conns:
                    raw = await asyncio.wait_for(r.read(), timeout=2.0)
                    slow_statuses.append(int(raw.split(b" ", 2)[1]))
                assert sorted(slow_statuses) == [408, 408, 408, 429, 429, 429]
            finally:
                for _, w in slow_conns:
                    w.close()
                    await w.wait_closed()

            assert all(target != "/api/v1/attacker-slow" for _, target, _, _ in upstream.requests)

    asyncio.run(scenario())


def test_global_body_and_connection_caps_shed_load_with_503_retry_after() -> None:
    async def scenario() -> None:
        # 1) Global body buffer cap across distinct client IPs returns 503 Retry-After: 1 while GET stays 200.
        async with _running_pair(
            global_body_slots=2,
            per_ip_body_slots=2,
            body_read_seconds=0.6,
        ) as (port, _upstream):
            s1_r, s1_w = await asyncio.open_connection("127.0.0.1", port)
            s2_r, s2_w = await asyncio.open_connection("127.0.0.1", port)
            try:
                for ip, w in (("198.51.100.1", s1_w), ("198.51.100.2", s2_w)):
                    w.write(
                        f"POST /api/v1/hold HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: {ip}\r\nContent-Length: 4096\r\n\r\nhi".encode(
                            "ascii"
                        )
                    )
                    await w.drain()
                await asyncio.sleep(0.08)

                busy_status, busy_hdrs, _ = await _raw_exchange(
                    port,
                    b"POST /api/v1/third HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: 198.51.100.3\r\nContent-Length: 4\r\n\r\ntest",
                )
                assert busy_status == 503
                assert busy_hdrs["retry-after"] == "1"

                read_status, _, _ = await _raw_exchange(
                    port,
                    b"GET /health/live HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: 198.51.100.3\r\n\r\n",
                )
                assert read_status == 200
            finally:
                for w in (s1_w, s2_w):
                    w.close()
                    await w.wait_closed()
                for r in (s1_r, s2_r):
                    with contextlib.suppress(Exception):
                        await asyncio.wait_for(r.read(), timeout=1.0)

        # 2) Global connection cap sheds excess sockets with 503 Retry-After: 1.
        async with _running_pair(max_connections=4, header_read_seconds=1.0) as (port, _upstream):
            held = [await asyncio.open_connection("127.0.0.1", port) for _ in range(4)]
            try:
                await asyncio.sleep(0.05)
                over_status, over_hdrs, _ = await _raw_exchange(
                    port, b"GET /health/live HTTP/1.1\r\nHost: localhost\r\n\r\n"
                )
                assert over_status == 503
                assert over_hdrs["retry-after"] == "1"
            finally:
                for _, w in held:
                    w.close()
                    await w.wait_closed()

    asyncio.run(scenario())


def test_normalize_client_bucket_token_bucket_and_cli_config_guards() -> None:
    assert normalize_client_bucket("198.51.100.42") == "198.51.100.42"
    assert normalize_client_bucket("::ffff:198.51.100.42") == "198.51.100.42"
    assert normalize_client_bucket("2001:db8:abcd:0012::1") == "2001:db8:abcd:12::/64"
    assert (
        normalize_client_bucket("2001:db8:abcd:0012:ffff:ffff:ffff:ffff") == "2001:db8:abcd:12::/64"
    )
    assert normalize_client_bucket("2001:db8:abcd:0013::1") == "2001:db8:abcd:13::/64"

    now = 100.0
    bucket = BurstTokenBucket(rate_per_second=2.0, burst=3, max_keys=2, clock=lambda: now)
    assert bucket.charge("198.51.100.1") is None
    assert bucket.charge("198.51.100.1") is None
    assert bucket.charge("198.51.100.1") is None
    assert bucket.charge("198.51.100.1") == 1
    now += 0.5
    assert bucket.charge("198.51.100.1") is None
    bucket.charge("198.51.100.2")
    bucket.charge("198.51.100.3")
    # 198.51.100.1 was evicted once max_keys=2 overflowed.
    assert len(bucket._entries) == 2

    with pytest.raises(SystemExit):
        build_config(["--require-trusted-edge"], environment={})

    with pytest.raises(SystemExit):
        build_config(
            ["--require-trusted-edge"],
            environment={
                "KODERA_TRUSTED_EDGE_ADDRESSES": "172.30.240.2/32",
                "DJANGO_DEBUG": "true",
            },
        )

    valid = build_config(
        ["--bind", "0.0.0.0:8080", "--upstream", "server:8000", "--require-trusted-edge"],
        environment={"KODERA_TRUSTED_EDGE_ADDRESSES": "172.30.240.2/32"},
    )
    assert valid.require_trusted_edge is True
    assert valid.trusted_edges == (ipaddress.ip_network("172.30.240.2/32"),)


def test_forged_underscore_headers_refused_400_and_cannot_bypass_per_ip_caps() -> None:
    with pytest.raises(_ProtocolRefusalError) as exc_info:
        _meta_from_headers("127.0.0.1", [("X_Forwarded_For", "203.0.113.200")])
    assert exc_info.value.status == 400

    async def scenario() -> None:
        async with _running_pair(
            global_body_slots=8,
            per_ip_body_slots=2,
            per_ip_queue_wait_seconds=0.05,
            body_read_seconds=0.5,
        ) as (port, upstream):
            forged_payloads = [
                b"POST /api/v1/forged HTTP/1.1\r\nHost: localhost\r\nX_Forwarded_For: 203.0.113.200\r\nContent-Length: 4\r\n\r\ntest",
                b"POST /api/v1/forged HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: 198.51.100.50\r\nX_Forwarded_For: 203.0.113.201\r\nContent-Length: 4\r\n\r\ntest",
                b"POST /api/v1/forged HTTP/1.1\r\nHost: localhost\r\nX-Forwarded_For: 203.0.113.202\r\nContent-Length: 4\r\n\r\ntest",
                b"GET /health/live HTTP/1.1\r\nHost: localhost\r\nX_Custom_Alias: 1\r\n\r\n",
            ]
            for raw_req in forged_payloads:
                status, _, _ = await _raw_exchange(port, raw_req)
                assert status == 400
            assert upstream.connect_count == 0

            # Saturate 198.51.100.50's 2 slow-body slots, then attempt bypass with rotating X_Forwarded_For.
            held = []
            try:
                for _ in range(2):
                    r, w = await asyncio.open_connection("127.0.0.1", port)
                    w.write(
                        b"POST /api/v1/hold HTTP/1.1\r\n"
                        b"Host: localhost\r\n"
                        b"X-Forwarded-For: 198.51.100.50\r\n"
                        b"Content-Length: 32768\r\n\r\n"
                        b"ab"
                    )
                    await w.drain()
                    held.append((r, w))
                await asyncio.sleep(0.08)

                for i in range(4):
                    bypass_status, _, _ = await _raw_exchange(
                        port,
                        f"POST /api/v1/bypass HTTP/1.1\r\n"
                        f"Host: localhost\r\n"
                        f"X-Forwarded-For: 198.51.100.50\r\n"
                        f"X_Forwarded_For: 203.0.113.{100 + i}\r\n"
                        f"Content-Length: 4\r\n\r\ntest".encode("ascii"),
                    )
                    assert bypass_status == 400
                assert upstream.connect_count == 0
            finally:
                for r, w in held:
                    w.close()
                    await w.wait_closed()
                    with contextlib.suppress(Exception):
                        await asyncio.wait_for(r.read(), timeout=1.0)

    asyncio.run(scenario())


def test_global_body_byte_budget_stream_reader_limit_and_fail_fast_503() -> None:
    assert STREAM_READER_LIMIT == 16_384
    assert DEFAULT_GLOBAL_BODY_SLOTS == 32
    assert DEFAULT_MAX_GLOBAL_BODY_BYTES == 33_554_432

    async def scenario() -> None:
        upstream = _RecordingUpstream()
        await upstream.start()
        config = AdmissionConfig(
            listen_host="127.0.0.1",
            listen_port=0,
            upstream_host="127.0.0.1",
            upstream_port=upstream.port,
            trusted_edges=(ipaddress.ip_network("127.0.0.1/32"),),
            require_trusted_edge=True,
            global_body_slots=8,
            max_global_body_bytes=1_048_576,
            per_ip_body_slots=4,
            body_read_seconds=0.8,
        )
        proxy = EdgeAdmissionServer(config)
        _, port = await proxy.start()
        held: list[tuple[asyncio.StreamReader, asyncio.StreamWriter]] = []
        try:
            # Reserve 700,000 + 300,000 = 1,000,000 bytes across 2 of 8 global slots (48,576 bytes free).
            for ip, length in (("198.51.100.1", 700_000), ("198.51.100.2", 300_000)):
                r, w = await asyncio.open_connection("127.0.0.1", port)
                w.write(
                    f"POST /api/v1/hold-bytes HTTP/1.1\r\n"
                    f"Host: localhost\r\n"
                    f"X-Forwarded-For: {ip}\r\n"
                    f"Content-Length: {length}\r\n\r\nhi".encode("ascii")
                )
                await w.drain()
                held.append((r, w))
            await asyncio.sleep(0.08)
            assert proxy._active_body_slots == 2
            assert proxy._active_body_bytes == 1_000_000

            # 100,000-byte fixed write exceeds remaining 48,576-byte budget and fails fast 503 (< 0.15s).
            t0 = time.monotonic()
            over_status, over_hdrs, _ = await _raw_exchange(
                port,
                b"POST /api/v1/byte-over HTTP/1.1\r\n"
                b"Host: localhost\r\n"
                b"X-Forwarded-For: 198.51.100.3\r\n"
                b"Content-Length: 100000\r\n\r\n" + b"x" * 1024,
            )
            assert over_status == 503
            assert over_hdrs["retry-after"] == "1"
            assert time.monotonic() - t0 < 0.2

            # Chunked write declaring a 65,536-byte chunk (> 48,576 free) also fails fast 503.
            chunk_over_status, chunk_over_hdrs, _ = await _raw_exchange(
                port,
                b"POST /api/v1/chunk-byte-over HTTP/1.1\r\n"
                b"Host: localhost\r\n"
                b"X-Forwarded-For: 198.51.100.4\r\n"
                b"Transfer-Encoding: chunked\r\n\r\n"
                b"10000\r\n" + b"y" * 1024,
            )
            assert chunk_over_status == 503
            assert chunk_over_hdrs["retry-after"] == "1"

            # A 16,384-byte fast write fits inside the remaining 48,576 bytes, succeeds 200,
            # and immediately releases its 16,384 bytes once flushed upstream.
            small = b"z" * 16_384
            fit_status, _, _ = await _raw_exchange(
                port,
                f"POST /api/v1/fits HTTP/1.1\r\n"
                f"Host: localhost\r\n"
                f"X-Forwarded-For: 198.51.100.5\r\n"
                f"Content-Length: {len(small)}\r\n\r\n".encode("ascii")
                + small,
            )
            assert fit_status == 200
            assert proxy._active_body_bytes == 1_000_000
        finally:
            for r, w in held:
                w.close()
                await w.wait_closed()
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(r.read(), timeout=1.0)
            await proxy.close()
            await upstream.close()
        assert proxy._active_body_slots == 0
        assert proxy._active_body_bytes == 0

    asyncio.run(scenario())
