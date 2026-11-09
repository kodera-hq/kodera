"""Owned loopback provider qualification; no production authentication authority."""

import base64
import hashlib
import http.client
import json
import secrets
import socket
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from html.parser import HTMLParser
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

from dev.accept_runtime import POSTGRES, docker

KEYCLOAK = "quay.io/keycloak/keycloak:26.7.3@sha256:ff4257d0d64efbe99ed1ddfaf07765cc3c36dc7518bf8324d41961327f441c54"
LABEL = "kodera.token-qualification"
REALM = "token-qualification"
CALLBACK = "http://127.0.0.1:1/callback"  # Intercepted redirect, never requested/bound.
MAX_RESPONSE = 256 * 1024


class FixtureError(Exception):
    """Closed diagnostics: provider input and credentials never enter messages."""


def require(condition, message):
    if not condition:
        raise FixtureError(message)


FIXTURE_REALMS = frozenset(
    {REALM, "directory-main", "directory-other", "directory-staff", "directory-unknown"}
)
FIXTURE_USERS = frozenset({"qualification", "alternate"})


def fixture_realm(password, callback, *, realm=REALM, usernames=("qualification",), expiring=False):
    require(realm in FIXTURE_REALMS, "fixture realm refused")
    require(
        isinstance(usernames, tuple)
        and 1 <= len(usernames) <= 2
        and len(set(usernames)) == len(usernames)
        and set(usernames) <= FIXTURE_USERS,
        "fixture usernames refused",
    )
    require(type(expiring) is bool, "fixture expiry option refused")
    clients = []
    for client_id in (
        ("console", "without-core-audience", "expiring-console")
        if expiring
        else ("console", "without-core-audience")
    ):
        client = {
            "clientId": client_id,
            "enabled": True,
            "protocol": "openid-connect",
            "publicClient": True,
            "standardFlowEnabled": True,
            "implicitFlowEnabled": False,
            "directAccessGrantsEnabled": False,
            "serviceAccountsEnabled": False,
            "redirectUris": [callback],
            "attributes": {"pkce.code.challenge.method": "S256"},
        }
        if client_id in {"console", "expiring-console"}:
            client["protocolMappers"] = [
                {
                    "name": "core-audience",
                    "protocol": "openid-connect",
                    "protocolMapper": "oidc-audience-mapper",
                    "config": {
                        "included.custom.audience": "kodera-server",
                        "access.token.claim": "true",
                        "id.token.claim": "false",
                    },
                }
            ]
        if client_id == "expiring-console":
            client["attributes"]["access.token.lifespan"] = "30"
        clients.append(client)
    value = {
        "realm": realm,
        "enabled": True,
        "sslRequired": "none",
        "registrationAllowed": False,
        "resetPasswordAllowed": False,
        "clients": clients,
        "users": [
            {
                "username": username,
                "enabled": True,
                "email": username + "@localhost",
                "emailVerified": True,
                "firstName": "Synthetic",
                "lastName": "Qualification",
                "requiredActions": [],
                "credentials": [{"type": "password", "value": password, "temporary": False}],
            }
            for username in usernames
        ],
    }
    if realm != REALM:
        value["accessTokenLifespan"] = 600
    return value


class LoopbackHTTP:
    """Fixed origin, no proxy/redirect machinery, bounded bytes and wall time."""

    def __init__(self, port, *, deadline=5.0, realm=REALM):
        require(realm in FIXTURE_REALMS, "fixture realm refused")
        self.realm = realm
        require(type(port) is int and 0 < port < 65536, "invalid local port")
        self.port = port
        self.origin = f"http://127.0.0.1:{port}"
        self.deadline = deadline

    def request(self, method, path, *, body=None, cookie=None):
        require(method in {"GET", "POST"}, "unsupported local method")
        require(
            path.startswith("/")
            and not path.startswith("//")
            and not any(c in path for c in "\r\n#"),
            "invalid local path",
        )
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        timer = None
        expired = threading.Event()
        started = time.monotonic()
        try:
            conn.connect()
            connection_socket = conn.sock
            require(connection_socket is not None, "local connection failed")
            connection_socket.settimeout(3)

            def interrupt():
                expired.set()
                try:
                    connection_socket.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

            remaining = self.deadline - (time.monotonic() - started)
            require(remaining > 0, "local response deadline exceeded")
            timer = threading.Timer(remaining, interrupt)
            timer.daemon = True
            timer.start()
            headers = {"Accept": "application/json, text/html"}
            if body is not None:
                headers["Content-Type"] = "application/x-www-form-urlencoded"
            if cookie:
                headers["Cookie"] = cookie  # Owned browser session, never JWKS request.
            conn.request(method, path, body=body, headers=headers)
            response = conn.getresponse()
            length = response.getheader("Content-Length")
            require(
                length is None or (length.isdigit() and int(length) <= MAX_RESPONSE),
                "local response too large",
            )
            data = response.read(MAX_RESPONSE + 1)
            require(len(data) <= MAX_RESPONSE, "local response too large")
            require(
                not expired.is_set() and time.monotonic() - started < self.deadline,
                "local response deadline exceeded",
            )
            return response.status, response.getheaders(), data
        except (OSError, http.client.HTTPException, ValueError):
            raise FixtureError("local transport failed") from None
        finally:
            if timer:
                timer.cancel()
            conn.close()

    def jwks(self):
        status, _, body = self.request("GET", f"/realms/{self.realm}/protocol/openid-connect/certs")
        require(status == 200, "public key response refused")
        return body


class LoginForm(HTMLParser):
    def __init__(self):
        super().__init__()
        self.action = None

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "form" and attributes.get("id") == "kc-form-login":
            require(self.action is None, "ambiguous login form")
            self.action = attributes.get("action")


def profile_only(token):
    """Unverified fixture observation only; never returned as verification evidence."""
    try:
        segment = token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)))
    except (ValueError, IndexError, TypeError):
        raise FixtureError("unexpected local token profile") from None


def expect_pkce_refusal(status, body, mode):
    try:
        error = json.loads(body)
        expected = {
            "missing": "PKCE code verifier not specified",
            "wrong": "PKCE verification failed: Code mismatch",
        }[mode]
        require(
            status == 400
            and error.get("error") == "invalid_grant"
            and error.get("error_description") == expected,
            "provider did not prove PKCE refusal",
        )
    except (KeyError, ValueError, AttributeError):
        raise FixtureError("provider did not prove PKCE refusal") from None


def code_flow(
    transport, password, client_id="console", *, verifier_mode="valid", username="qualification"
):
    realm = getattr(transport, "realm", REALM)
    require(realm in FIXTURE_REALMS, "fixture realm refused")
    require(username in FIXTURE_USERS, "fixture username refused")
    require(
        client_id in {"console", "without-core-audience", "expiring-console"},
        "fixture client refused",
    )
    verifier = secrets.token_urlsafe(48)
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    )
    state, nonce = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
    path = f"/realms/{realm}/protocol/openid-connect/auth?" + urlencode(
        {
            "client_id": client_id,
            "redirect_uri": CALLBACK,
            "response_type": "code",
            "scope": "openid",
            "state": state,
            "nonce": nonce,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
    )
    status, headers, body = transport.request("GET", path)
    require(status == 200, "local authorization page refused")
    form = LoginForm()
    form.feed(body.decode("utf-8"))
    require(isinstance(form.action, str), "local login form absent")
    action = urlsplit(form.action)
    require(
        f"{action.scheme}://{action.netloc}" == transport.origin
        and action.path == f"/realms/{realm}/login-actions/authenticate"
        and not action.fragment,
        "local login form escaped origin",
    )
    cookies = SimpleCookie()
    for name, value in headers:
        if name.lower() == "set-cookie":
            cookies.load(value)
    cookie = "; ".join(f"{name}={item.value}" for name, item in cookies.items())
    status, headers, _ = transport.request(
        "POST",
        action.path + "?" + action.query,
        body=urlencode({"username": username, "password": password}),
        cookie=cookie,
    )
    require(status == 302, "local login did not complete")
    locations = [value for name, value in headers if name.lower() == "location"]
    require(len(locations) == 1, "ambiguous local authorization redirect")
    callback = urlsplit(locations[0])
    require(
        f"{callback.scheme}://{callback.netloc}{callback.path}" == CALLBACK
        and not callback.fragment,
        "local authorization escaped callback",
    )
    query = parse_qs(callback.query)
    require(
        query.get("state") == [state] and len(query.get("code", [])) == 1,
        "local authorization state/code mismatch",
    )
    parameters = {
        "grant_type": "authorization_code",
        "client_id": client_id,
        "redirect_uri": CALLBACK,
        "code": query["code"][0],
    }
    if verifier_mode != "missing":
        parameters["code_verifier"] = (
            verifier if verifier_mode == "valid" else secrets.token_urlsafe(48)
        )
    status, _, body = transport.request(
        "POST", f"/realms/{realm}/protocol/openid-connect/token", body=urlencode(parameters)
    )
    if verifier_mode != "valid":
        expect_pkce_refusal(status, body, verifier_mode)
        return None
    require(status == 200, "local token exchange refused")
    try:
        tokens = json.loads(body)
        require(tokens["token_type"] == "Bearer", "unexpected token wrapper")  # noqa: S105 - protocol constant
        require(profile_only(tokens["access_token"])["typ"] == "Bearer", "access profile mismatch")
        require(profile_only(tokens["id_token"])["typ"] == "ID", "ID profile mismatch")
        require(profile_only(tokens["id_token"])["nonce"] == nonce, "local nonce mismatch")
        return tokens
    except (KeyError, ValueError, TypeError):
        raise FixtureError("local token response malformed") from None


def remove_owned(kind, name, owner):
    result = docker(kind, "inspect", name, check=False)
    if result.returncode:
        return
    details = json.loads(result.stdout)[0]
    labels = details.get("Labels") if kind == "network" else details["Config"].get("Labels")
    require((labels or {}).get(LABEL) == owner, "refusing unowned cleanup")
    docker(kind, "rm", *(["-f"] if kind == "container" else []), name)


def wait_for_jwks(transport):
    """Allow cold-start augmentation/import a finite monotonic readiness window.

    A request begun before the deadline retains its own unchanged five-second
    limit; no subsequent request starts at or after the readiness deadline.
    """
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        try:
            transport.jwks()
            return
        except FixtureError:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(0.5, remaining))
    raise FixtureError("local identity provider not ready")


@contextmanager
def owned_provider():
    owner = "core-tokens-" + uuid.uuid4().hex[:12]
    names = [owner + "-provider", owner + "-db"]
    password = secrets.token_urlsafe(32)
    try:
        with tempfile.TemporaryDirectory(prefix="core-token-import-") as directory:
            Path(directory).chmod(0o755)  # Container reads only this synthetic import.
            realm = fixture_realm(password, CALLBACK)
            content = json.dumps(realm, sort_keys=True)
            target = Path(directory) / "realm.json"
            target.write_text(content)
            target.chmod(0o644)
            docker("network", "create", "--label", f"{LABEL}={owner}", owner)
            docker(
                "run",
                "-d",
                "--name",
                names[1],
                "--label",
                f"{LABEL}={owner}",
                "--network",
                owner,
                "--network-alias",
                "identity-db",
                "--tmpfs",
                "/var/lib/postgresql/data:rw,noexec,nosuid,size=256m",
                "-e",
                "POSTGRES_DB=identity",
                "-e",
                "POSTGRES_USER=identity",
                "-e",
                "POSTGRES_PASSWORD=synthetic-local-only",
                POSTGRES,
            )
            for _ in range(60):
                if (
                    docker("exec", names[1], "pg_isready", "-U", "identity", check=False).returncode
                    == 0
                ):
                    break
                time.sleep(0.5)
            else:
                raise FixtureError("local identity database not ready")
            docker(
                "run",
                "-d",
                "--name",
                names[0],
                "--label",
                f"{LABEL}={owner}",
                "--network",
                owner,
                "-p",
                "127.0.0.1::8080",
                "--memory",
                "1g",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges:true",
                "-v",
                f"{directory}:/opt/keycloak/data/import:ro",
                "-e",
                "KC_DB=postgres",
                "-e",
                "KC_DB_URL=jdbc:postgresql://identity-db/identity",
                "-e",
                "KC_DB_USERNAME=identity",
                "-e",
                "KC_DB_PASSWORD=synthetic-local-only",
                KEYCLOAK,
                "start-dev",
                "--import-realm",
                timeout=180,
            )
            port = int(docker("port", names[0], "8080/tcp").stdout.strip().rsplit(":", 1)[1])
            transport = LoopbackHTTP(port)
            wait_for_jwks(transport)
            yield transport, password
    finally:
        for name in names:
            remove_owned("container", name, owner)
        remove_owned("network", owner, owner)
