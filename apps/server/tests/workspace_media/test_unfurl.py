"""No real network is used: all DNS and socket answers are owned synthetic fixtures."""

import io
import ipaddress
import secrets
import socket
import time
from email.message import Message
from types import SimpleNamespace

import pytest

from apps.media import outbound, unfurl


def global_ip():
    while True:
        address = ipaddress.ip_address(secrets.randbits(32))
        if address.is_global and not address.is_multicast and not address.is_reserved:
            return str(address)


@pytest.mark.parametrize(
    "ip",
    [
        "127.0.0.1",
        "10.0.0.1",
        "172.16.0.1",
        "192.168.0.1",
        "100.64.0.1",
        "169.254.169.254",
        "0.0.0.1",
        "224.0.0.1",
        "240.0.0.1",
        "::1",
        "fc00::1",
        "fe80::1",
        "::ffff:127.0.0.1",
        "::ffff:8.8.8.8",
        "64:ff9b::a9fe:a9fe",
    ],
)
def test_private_reserved_and_translated_addresses_refuse(ip):
    with pytest.raises(outbound.BlockedTargetError):
        outbound.public_address(ip)


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://example.org/a",
        "https://user:password@example.org/",
        "https://example.org:0/",
        "https://example.org:8443/",
        "https://example.org/%xx",
        "https://example.org\\@localhost/",
        "http://localhost/",
        "http://example.org/\r\n",
    ],
)
def test_url_syntax_cannot_bypass_the_transport_policy(url):
    with pytest.raises(outbound.BlockedTargetError):
        outbound.target(url)


def test_all_dns_answers_are_checked_before_any_connection(monkeypatch):
    allowed = global_ip()
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *args: [
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (allowed, 443)),
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("127.0.0.1", 443)),
        ],
    )
    with pytest.raises(outbound.BlockedTargetError):
        outbound.addresses(outbound.target("https://example.org/"), time.monotonic() + 3)


class FakeSocket:
    def __init__(self, wire):
        self.wire, self.sent, self.connected, self.timeouts = wire, b"", None, []
        self.closed = False

    def settimeout(self, timeout):
        self.timeouts.append(timeout)

    def connect(self, address):
        self.connected = address

    def makefile(self, mode, buffering=0):
        return io.BytesIO(self.wire)

    def sendall(self, value):
        self.sent += value

    def close(self):
        self.closed = True


def test_dns_rebinding_cannot_change_the_pinned_tcp_address_or_tls_hostname(monkeypatch):
    approved = global_ip()
    calls = []

    def dns(*args):
        calls.append(args)
        value = approved if len(calls) == 1 else "127.0.0.1"
        return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (value, 443))]

    wire = b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
    transport = FakeSocket(wire)
    sni = []
    context = SimpleNamespace(
        set_alpn_protocols=lambda _: None,
        wrap_socket=lambda raw, server_hostname: sni.append(server_hostname) or raw,
    )
    monkeypatch.setattr(socket, "getaddrinfo", dns)
    monkeypatch.setattr(socket, "socket", lambda *args: transport)
    monkeypatch.setattr(outbound.ssl, "create_default_context", lambda: context)
    result = unfurl.unfurl("https://example.org/")
    assert result["url"] == "https://example.org/"
    assert len(calls) == 1
    assert transport.connected == (approved, 443)
    assert sni == ["example.org"]
    assert b"Host: example.org\r\n" in transport.sent
    assert transport.closed


def response(body=b"", *, status=200, headers=None):
    message = Message()
    for key, value in (headers or {"Content-Type": "text/html"}).items():
        message[key] = value
    stream = io.BytesIO(body)
    result = SimpleNamespace(
        status=status, headers=message, chunked=False, received=0, closed=False
    )
    result.getheader = lambda key, default=None: message.get(key, default)

    def read(size):
        value = stream.read(size)
        result.received += len(value)
        return value

    result.read1 = read
    result.close = lambda: setattr(result, "closed", True)
    return result


def test_redirect_to_loopback_is_revalidated_before_connect(monkeypatch):
    redirect = response(status=302, headers={"Location": "http://169.254.169.254/latest/"})
    calls = []

    def fetch(destination, **kwargs):
        calls.append(destination.url)
        if len(calls) > 1:
            outbound.addresses(destination, kwargs["deadline"])
            raise AssertionError("private target was not refused")
        return SimpleNamespace(close=lambda: None), redirect

    monkeypatch.setattr(unfurl, "request", fetch)
    with pytest.raises(outbound.BlockedTargetError):
        unfurl.unfurl("https://example.org/")
    assert redirect.closed


def test_redirect_budget_allows_three_hops_and_refuses_fourth_or_non_web_port(monkeypatch):
    hops = [
        response(status=302, headers={"Location": "https://example.org/hop-1"}),
        response(status=302, headers={"Location": "https://example.org/hop-2"}),
        response(status=302, headers={"Location": "https://example.org/hop-3"}),
        response(b"<title>Reached</title>"),
    ]
    seen = []

    def fetch_three(destination, **kwargs):
        seen.append(destination.url)
        return SimpleNamespace(close=lambda: None), hops[len(seen) - 1]

    monkeypatch.setattr(unfurl, "request", fetch_three)
    result = unfurl.unfurl("https://example.org/start")
    assert result["canonicalUrl"] == "https://example.org/hop-3"
    assert result["title"] == "Reached"
    assert len(seen) == 4

    too_many = [
        response(status=302, headers={"Location": f"https://example.org/hop-{index}"})
        for index in range(1, 5)
    ]
    count = [0]

    def fetch_four(destination, **kwargs):
        index = count[0]
        count[0] += 1
        return SimpleNamespace(close=lambda: None), too_many[index]

    monkeypatch.setattr(unfurl, "request", fetch_four)
    with pytest.raises(outbound.BlockedTargetError):
        unfurl.unfurl("https://example.org/start")
    assert count[0] == 4

    bad_port = response(status=302, headers={"Location": "https://example.org:8443/next"})
    monkeypatch.setattr(
        unfurl, "request", lambda *args, **kwargs: (SimpleNamespace(close=lambda: None), bad_port)
    )
    with pytest.raises(outbound.BlockedTargetError):
        unfurl.unfurl("https://example.org/start")
    assert bad_port.closed


def test_large_unknown_length_body_is_capped_and_connection_closed(monkeypatch):
    answer = response(b"x" * (unfurl.MAX_BODY + 10000))
    monkeypatch.setattr(
        unfurl, "request", lambda *args, **kwargs: (SimpleNamespace(close=lambda: None), answer)
    )
    with pytest.raises(outbound.FetchError, match="fetch refused") as failure:
        unfurl.unfurl("https://example.org/")
    assert failure.value.reason == "too-large"
    assert answer.received == unfurl.MAX_BODY + 1
    assert answer.closed


def test_metadata_is_plain_text_and_private_canonical_and_unvalidated_image_are_omitted(
    monkeypatch,
):
    body = b"""<title>Fallback</title><meta property="og:title" content="&lt;script&gt;bad()&lt;/script&gt;Safe &lt;b&gt;title&lt;/b&gt;"><meta name="description" content="&lt;img src=x onerror=bad()&gt;Description"><link rel="canonical" href="http://127.0.0.1/private"><meta property="og:image" content="http://169.254.169.254/image">"""
    answer = response(body)
    monkeypatch.setattr(
        unfurl, "request", lambda *args, **kwargs: (SimpleNamespace(close=lambda: None), answer)
    )
    result = unfurl.unfurl("https://example.org/article")
    assert result["title"] == "Safe title"
    assert result["description"] == "Description"
    assert result["canonicalUrl"] == "https://example.org/article"
    assert "image" not in result


def test_socket_file_retains_the_transport_until_response_close():
    left, right = socket.socketpair()
    try:
        transport = outbound._Transport(left, time.monotonic() + 1)
        reader = transport.makefile("rb")
        transport.close()
        right.sendall(b"ok")
        assert reader.read(2) == b"ok"
        reader.close()
    finally:
        left.close()
        right.close()


def test_tls_handshake_uses_only_the_time_left_after_tcp_connect(monkeypatch):
    now = [100.0]
    monkeypatch.setattr(outbound.time, "monotonic", lambda: now[0])
    wire = FakeSocket(b"")

    def connect(address):
        wire.connected = address
        now[0] = 102.9

    wire.connect = connect
    observed = []

    def tls(raw, server_hostname):
        observed.append(raw.timeouts[-1])
        return raw

    context = SimpleNamespace(set_alpn_protocols=lambda _: None, wrap_socket=tls)
    monkeypatch.setattr(outbound.socket, "socket", lambda *args: wire)
    monkeypatch.setattr(outbound.ssl, "create_default_context", lambda: context)
    destination = outbound.target("https://example.org/")
    approved = global_ip()
    connection = outbound.PinnedConnection(
        destination,
        [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (approved, 443))],
        103.0,
    )
    try:
        connection.connect()
        assert 0 < observed[0] < 0.11
    finally:
        connection.close()
