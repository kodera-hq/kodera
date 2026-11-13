"""The real shared pinned TLS transport carries signed bodies and refuses rebinding/redirects."""

import socket
from types import SimpleNamespace

import pytest
from test_extension_wire import vector
from workspace_media.test_unfurl import FakeSocket, global_ip

from apps.extensions.dispatcher import send
from apps.media import outbound


def socket_fixture(monkeypatch, *, status=200, mixed=False):
    public = global_ip()
    calls = []
    sni = []

    def dns(*args):
        calls.append(args)
        answers = [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (public, 443))]
        if mixed:
            answers.append(
                (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("127.0.0.1", 443))
            )
        return answers

    wire = f"HTTP/1.1 {status} Synthetic\r\nContent-Length: 0\r\nLocation: https://127.0.0.1/private\r\nConnection: close\r\n\r\n".encode()
    owned = FakeSocket(wire)
    context = SimpleNamespace(
        set_alpn_protocols=lambda _: None,
        wrap_socket=lambda raw, server_hostname: sni.append(server_hostname) or raw,
    )
    monkeypatch.setattr(socket, "getaddrinfo", dns)
    monkeypatch.setattr(socket, "socket", lambda *args: owned)
    monkeypatch.setattr(outbound.ssl, "create_default_context", lambda: context)
    return owned, calls, sni, public


def test_signed_python_body_reaches_only_resolved_public_socket_with_tls_identity(monkeypatch):
    owned, calls, sni, public = socket_fixture(monkeypatch)
    signed = vector()
    assert send("https://hooks.example.org/receive", signed) == ("delivered", 200)
    assert len(calls) == 1 and owned.connected == (public, 443) and sni == ["hooks.example.org"]
    assert b"Host: hooks.example.org\r\n" in owned.sent
    assert signed.headers["X-Kodera-Signature-256"].encode() in owned.sent
    assert owned.sent.endswith(signed.body) and owned.closed


@pytest.mark.parametrize("status", [301, 302, 307, 308])
def test_redirect_refuses_without_resolving_or_sending_to_location(monkeypatch, status):
    owned, calls, _, _ = socket_fixture(monkeypatch, status=status)
    assert send("https://hooks.example.org/receive", vector()) == ("refused", status)
    assert len(calls) == 1 and owned.closed


def test_mixed_public_private_dns_refuses_before_any_socket_connection(monkeypatch):
    owned, calls, _, _ = socket_fixture(monkeypatch, mixed=True)
    assert send("https://hooks.example.org/receive", vector()) == ("refused", None)
    assert owned.connected is None and not owned.sent and len(calls) == 1


@pytest.mark.parametrize(
    "endpoint",
    [
        "https://169.254.169.254/",
        "https://[::ffff:127.0.0.1]/",
        "https://100.64.0.1/",
        "https://user:secret@example.org/",
        "http://hooks.example.org/",
    ],
)
def test_metadata_translated_cgnat_credentials_and_plaintext_targets_never_send(endpoint):
    assert send(endpoint, vector()) == ("refused", None)
