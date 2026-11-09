"""Local fixture contract; no container or token outputs during ordinary tests."""

import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from dev.identity_fixture import FixtureError, LoopbackHTTP, fixture_realm


def test_fixture_uses_real_pkce_and_core_audience_without_fake_mfa():
    realm = fixture_realm("synthetic-password", "http://127.0.0.1:51234/callback")
    for client in realm["clients"]:
        assert client["publicClient"] is True
        assert client["standardFlowEnabled"] is True
        assert client["directAccessGrantsEnabled"] is False
        assert client["serviceAccountsEnabled"] is False
        assert client["attributes"]["pkce.code.challenge.method"] == "S256"
        assert client["redirectUris"] == ["http://127.0.0.1:51234/callback"]
    mapped, unmapped = realm["clients"]
    assert mapped["protocolMappers"][0]["config"]["included.custom.audience"] == "kodera-server"
    assert mapped["protocolMappers"][0]["config"]["id.token.claim"] == "false"
    assert unmapped.get("protocolMappers", []) == []
    assert "amr" not in str(realm)
    assert realm["users"][0]["requiredActions"] == []


@contextmanager
def local_response(mode):
    seen = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            seen.append(dict(self.headers))
            try:
                if mode == "slow_headers":
                    for part in (b"HTTP/1.1 200 OK\r\n", b"X-Test: ", *([b"x"] * 40)):
                        self.wfile.write(part)
                        self.wfile.flush()
                        time.sleep(0.025)
                    return
                self.send_response(302 if mode == "redirect" else 200)
                if mode == "redirect":
                    self.send_header("Location", "http://attacker.invalid/")
                if mode == "oversize_length":
                    self.send_header("Content-Length", str((256 * 1024) + 1))
                self.end_headers()
                if mode == "slow_body":
                    for _ in range(40):
                        self.wfile.write(b"x")
                        self.wfile.flush()
                        time.sleep(0.025)
                else:
                    self.wfile.write(
                        b"x" * ((256 * 1024) + 1) if mode == "oversize_body" else b'{"keys":[]}'
                    )
            except (ConnectionError, OSError):
                pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_port, seen
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


@pytest.mark.parametrize(
    "mode", ["redirect", "oversize_length", "oversize_body", "slow_headers", "slow_body"]
)
def test_local_jwks_transport_bounds_and_refuses_redirect(mode):
    with local_response(mode) as (port, seen):
        start = time.monotonic()
        with pytest.raises(FixtureError):
            LoopbackHTTP(port, deadline=0.2).jwks()
        elapsed = time.monotonic() - start
        assert elapsed < 0.8, "slow peer defeated overall deadline"
        assert len(seen) == 1, "redirect followed"


def test_local_jwks_ignores_proxy_environment_and_sends_no_credentials(monkeypatch):
    monkeypatch.setenv("HTTP_PROXY", "http://synthetic-user:synthetic-password@127.0.0.1:1")
    monkeypatch.setenv("ALL_PROXY", "http://127.0.0.1:1")
    with local_response("valid") as (port, seen):
        assert LoopbackHTTP(port).jwks() == b'{"keys":[]}'
        assert not any(
            name in seen[0] for name in ("Authorization", "Proxy-Authorization", "Cookie")
        )


@pytest.mark.parametrize("port", [0, -1, 65536, True, "123"])
def test_local_transport_refuses_invalid_ports(port):
    with pytest.raises(FixtureError):
        LoopbackHTTP(port)


@pytest.mark.parametrize(
    "path",
    ["//attacker.invalid/", "http://attacker.invalid/", "/path\r\nInjected: yes", "/path#fragment"],
)
def test_local_transport_refuses_origin_escape_before_connect(path):
    with pytest.raises(FixtureError, match="invalid local path"):
        LoopbackHTTP(1).request("GET", path)


@pytest.mark.parametrize(
    "mode, description",
    [
        ("missing", "PKCE code verifier not specified"),
        ("wrong", "PKCE verification failed: Code mismatch"),
    ],
)
def test_pkce_refusal_requires_precise_closed_provider_error(mode, description):
    import json

    from dev.identity_fixture import expect_pkce_refusal

    body = {"error": "invalid_grant", "error_description": description}
    expect_pkce_refusal(400, json.dumps(body).encode(), mode)
    for bad in (
        {**body, "error": "invalid_client"},
        {**body, "error_description": "Code is expired"},
        {},
    ):
        with pytest.raises(FixtureError, match="did not prove PKCE refusal"):
            expect_pkce_refusal(400, json.dumps(bad).encode(), mode)


def test_directory_realms_users_and_expiry_keep_legitimate_client_flow():
    realm = fixture_realm(
        "synthetic-password",
        "http://127.0.0.1:1/callback",
        realm="directory-main",
        usernames=("qualification", "alternate"),
        expiring=True,
    )
    assert realm["realm"] == "directory-main"
    assert realm["accessTokenLifespan"] == 600
    assert [user["username"] for user in realm["users"]] == ["qualification", "alternate"]
    assert [client["clientId"] for client in realm["clients"]] == [
        "console",
        "without-core-audience",
        "expiring-console",
    ]
    for client in realm["clients"]:
        assert client["standardFlowEnabled"] and client["publicClient"]
        assert not client["directAccessGrantsEnabled"] and not client["serviceAccountsEnabled"]
        assert client["attributes"]["pkce.code.challenge.method"] == "S256"
    short = realm["clients"][2]
    assert short["attributes"]["access.token.lifespan"] == "30"
    assert short["protocolMappers"][0]["config"]["included.custom.audience"] == "kodera-server"
    assert "amr" not in str(realm)
    assert LoopbackHTTP(12345, realm="directory-other").realm == "directory-other"


@pytest.mark.parametrize(
    "options,reason",
    [
        ({"realm": "outside-realm"}, "fixture realm refused"),
        ({"usernames": ("qualification", "qualification")}, "fixture usernames refused"),
        ({"usernames": ("unknown",)}, "fixture usernames refused"),
        ({"expiring": 1}, "fixture expiry option refused"),
    ],
)
def test_directory_fixture_options_are_finite(options, reason):
    with pytest.raises(FixtureError, match=reason):
        fixture_realm("synthetic-password", "http://127.0.0.1:1/callback", **options)
