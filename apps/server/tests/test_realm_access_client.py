"""The realm access delivery's Keycloak client and credential, without a database:
docs/specs/MEMBERSHIP_LIFECYCLE.md §§6.1.2, 6.1.3, 6.1.5.

Two in-process HTTP stubs stand for one Keycloak behind its two names: the public host, which
serves the token endpoint and answers 403 on `/admin` as production's proxy does, and the admin
host, which serves the Admin REST API. Both origins are pinned by settings, never read from a
delivery. Nothing here needs PostgreSQL or a container.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import urllib.parse
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from apps.outbox import realm_access
from apps.outbox.realm import keycloak
from apps.outbox.realm.keycloak import RealmCallError, RealmOrigins, RealmTarget
from worker.credentials import CredentialUnavailableError, DirectoryCredentialSource

ROOT = Path(__file__).resolve().parents[1]
SECRET = "WoRkErSeCrEt-0123456789abcdefXYZ"
TOKEN = "eyJhbGciOiJFUzI1NiJ9.AcCeSsToKeN.SiGnAtUrE"
EMAIL = "kept.attribute@lab.test"


@dataclass
class Keycloak:
    """What both hosts serve, and every request each received."""

    requests: list[dict[str, Any]] = field(default_factory=list)
    users: dict[str, dict[str, Any]] = field(default_factory=dict)
    offline: dict[str, set[str]] = field(default_factory=dict)
    sessions: dict[str, list[str]] = field(default_factory=dict)
    override: dict[tuple[str, str, str], tuple[int, Any]] = field(default_factory=dict)
    token: tuple[int, Any] = (200, {"access_token": TOKEN})
    delay: dict[tuple[str, str, str], float] = field(default_factory=dict)
    # A path whose body is trickled one byte at a time, this many seconds apart.
    trickle: dict[tuple[str, str, str], float] = field(default_factory=dict)
    realm: str = "alpha"

    def add_user(self, user_id: str = "kc-user-1") -> str:
        self.users[user_id] = {
            "id": user_id,
            "username": "synthetic",
            "enabled": True,
            "email": EMAIL,
        }
        self.sessions[user_id] = ["s1"]
        self.offline[user_id] = {"console", "visio client"}
        return user_id

    def admin_calls(self) -> list[tuple[str, str]]:
        return [(r["method"], r["path"]) for r in self.requests if r["host"] == "admin"]


def _handler(kc: Keycloak, host: str) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:
            return

        def _answer(self, status: int, payload: Any = None, location: str | None = None) -> None:
            body = b"" if payload is None else json.dumps(payload).encode()
            self.send_response(status)
            if location:
                self.send_header("Location", location)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _handle(self, method: str) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length).decode() if length else ""
            path = urllib.parse.urlsplit(self.path).path
            kc.requests.append(
                {
                    "host": host,
                    "method": method,
                    "path": path,
                    "query": urllib.parse.urlsplit(self.path).query,
                    "authorization": self.headers.get("Authorization"),
                    "body": body,
                }
            )
            if (host, method, path) in kc.delay:
                time.sleep(kc.delay[(host, method, path)])  # the server still works on it
            if (host, method, path) in kc.trickle:
                trickled = b"[" + b" " * 400 + b"]"
                self.send_response(200)
                self.send_header("Content-Length", str(len(trickled)))
                self.end_headers()
                for byte in trickled:
                    self.wfile.write(bytes([byte]))
                    self.wfile.flush()
                    time.sleep(kc.trickle[(host, method, path)])
                return None
            if (host, method, path) in kc.override:
                status, payload = kc.override[(host, method, path)]
                if 300 <= status < 400:
                    return self._answer(status, None, payload)
                return self._answer(status, payload)
            if host == "public":
                if path == f"/realms/{kc.realm}/protocol/openid-connect/token" and method == "POST":
                    return self._answer(*kc.token)
                if path.startswith("/admin"):
                    return self._answer(403)  # production's proxy refuses /admin here
                return self._answer(404)
            if self.headers.get("Authorization") != "Bearer " + TOKEN:
                return self._answer(401)
            prefix = f"/admin/realms/{kc.realm}/users"
            if not path.startswith(prefix):
                return self._answer(404, {"error": "Realm not found."})
            if path == prefix + "/count" and method == "GET":
                return self._answer(200, len(kc.users))
            if path == prefix and method == "GET":
                query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                assert query.get("enabled") == ["true"] and query.get("briefRepresentation") == [
                    "true"
                ]
                first, size = int(query["first"][0]), int(query["max"][0])
                enabled = sorted(u for u, rep in kc.users.items() if rep["enabled"])
                return self._answer(200, [{"id": u} for u in enabled[first : first + size]])
            user_id, _, tail = path[len(prefix) + 1 :].partition("/")
            user = kc.users.get(user_id)
            if user is None:
                return self._answer(404, {"error": "User not found"})
            if tail == "" and method == "GET":
                return self._answer(200, user)
            if tail == "" and method == "PUT":
                user.update(json.loads(body))
                return self._answer(204)
            if tail == "execute-actions-email" and method == "PUT":
                return self._answer(204)
            if tail == "logout" and method == "POST":
                kc.sessions[user_id] = []
                return self._answer(204)
            if tail == "sessions" and method == "GET":
                return self._answer(200, [{"id": s} for s in kc.sessions.get(user_id, [])])
            if tail == "consents" and method == "GET":
                return self._answer(200, [{"clientId": c} for c in sorted(kc.offline[user_id])])
            if tail.startswith("consents/") and method == "DELETE":
                client = urllib.parse.unquote(tail.split("/", 1)[1])
                if client not in kc.offline[user_id]:
                    return self._answer(404)
                kc.offline[user_id].discard(client)
                return self._answer(204)
            return self._answer(400)

        def do_GET(self) -> None:  # noqa: N802
            self._handle("GET")

        def do_PUT(self) -> None:  # noqa: N802
            self._handle("PUT")

        def do_POST(self) -> None:  # noqa: N802
            self._handle("POST")

        def do_DELETE(self) -> None:  # noqa: N802
            self._handle("DELETE")

    return Handler


@contextmanager
def keycloak_hosts() -> Iterator[tuple[Keycloak, RealmOrigins]]:
    """One Keycloak behind a public and an admin origin, both on loopback."""
    kc = Keycloak()
    servers = [
        ThreadingHTTPServer(("127.0.0.1", 0), _handler(kc, host)) for host in ("public", "admin")
    ]
    for server in servers:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    public, admin = (f"http://127.0.0.1:{server.server_address[1]}" for server in servers)
    try:
        yield kc, RealmOrigins(issuer=public, admin=admin)
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()


@pytest.fixture
def source(tmp_path):
    secrets = tmp_path / "secrets"
    secrets.mkdir()
    (secrets / "alpha").write_text(SECRET + "\n")
    return DirectoryCredentialSource(secrets)


@contextmanager
def admin_of(kc_origins: RealmOrigins, source: DirectoryCredentialSource):
    with keycloak.keycloak_admin(RealmTarget("alpha"), source=source, origins=kc_origins) as admin:
        yield admin


# ------------------------------------------------------------------ pinned origins ----


def test_the_token_goes_to_the_pinned_public_origin_and_the_admin_calls_to_the_admin_origin(
    source,
):
    with keycloak_hosts() as (kc, origins):
        user_id = kc.add_user()
        with admin_of(origins, source) as admin:
            assert realm_access.turn_off(admin, user_id) is None
        public = [r for r in kc.requests if r["host"] == "public"]
        assert [(r["method"], r["path"]) for r in public] == [
            ("POST", "/realms/alpha/protocol/openid-connect/token")
        ]
        assert urllib.parse.parse_qs(public[0]["body"]) == {
            "grant_type": ["client_credentials"],
            "client_id": ["kodera-identity-worker"],
            "client_secret": [SECRET],
        }
        base = "/admin/realms/alpha/users/" + user_id
        assert kc.admin_calls() == [
            ("GET", base),
            ("PUT", base),
            ("POST", base + "/logout"),
            ("GET", base + "/consents"),
            ("DELETE", base + "/consents/console"),
            ("DELETE", base + "/consents/visio%20client"),
            ("GET", base),
            ("GET", base + "/sessions"),
            ("GET", base + "/consents"),
        ]
        assert all(
            r["authorization"] == "Bearer " + TOKEN for r in kc.requests if r["host"] == "admin"
        )
        assert kc.users[user_id]["enabled"] is False and kc.users[user_id]["email"] == EMAIL


def test_the_put_carries_only_the_enabled_flag(source):
    with keycloak_hosts() as (kc, origins):
        user_id = kc.add_user()
        with admin_of(origins, source) as admin:
            realm_access.turn_off(admin, user_id)
            realm_access.turn_on(admin, user_id)
        puts = [json.loads(r["body"]) for r in kc.requests if r["method"] == "PUT"]
        assert puts == [{"enabled": False}, {"enabled": True}], "PUT carried more than enabled"


@pytest.mark.parametrize(
    ("returns", "query"),
    [
        # Unset: no client, no redirect, exactly the call made before the setting existed.
        ({}, "lifespan=259200"),
        (
            {"client_id": "console", "redirect_uri": "https://app.example.test/"},
            "lifespan=259200&client_id=console&redirect_uri=https%3A%2F%2Fapp.example.test%2F",
        ),
        # Both or neither: a client without a redirect is not sent.
        ({"client_id": "console"}, "lifespan=259200"),
    ],
)
def test_the_set_up_mail_names_the_console_only_when_both_are_given(source, returns, query):
    with keycloak_hosts() as (kc, origins):
        user_id = kc.add_user()
        with admin_of(origins, source) as admin:
            admin.execute_actions_email(user_id, ["UPDATE_PASSWORD"], 3 * 24 * 3600, **returns)
        [put] = [r for r in kc.requests if r["method"] == "PUT"]
        assert put["path"] == f"/admin/realms/alpha/users/{user_id}/execute-actions-email"
        assert put["query"] == query
        assert json.loads(put["body"]) == ["UPDATE_PASSWORD"]


def test_admin_calls_sent_to_the_public_host_are_a_credential_failure(source):
    with keycloak_hosts() as (kc, origins):
        kc.add_user()
        misrouted = RealmOrigins(issuer=origins.issuer, admin=origins.issuer)
        with admin_of(misrouted, source) as admin, pytest.raises(RealmCallError) as raised:
            admin.get_user("kc-user-1")
        assert (raised.value.kind, raised.value.http_status) == ("credential", 403)


@pytest.mark.parametrize(
    "answer", [(400, {"error": "unauthorized_client"}), (401, {"error": "invalid_client"})]
)
def test_a_disabled_or_refused_worker_client_is_a_credential_failure(source, answer):
    with keycloak_hosts() as (kc, origins):
        kc.token = answer
        with pytest.raises(RealmCallError) as raised, admin_of(origins, source):
            pass
        assert (raised.value.kind, raised.value.http_status) == ("credential", answer[0])
        assert kc.admin_calls() == []


def test_a_missing_credential_file_is_a_credential_failure(tmp_path):
    with keycloak_hosts() as (kc, origins):
        empty = DirectoryCredentialSource(tmp_path)
        with pytest.raises(RealmCallError) as raised, admin_of(origins, empty):
            pass
        assert raised.value.kind == "credential" and kc.requests == []


# -------------------------------------------------------------- an absent user ----


def test_an_absent_user_is_accepted_only_when_the_realm_answers(source):
    with keycloak_hosts() as (kc, origins):
        with admin_of(origins, source) as admin:
            assert realm_access.turn_off(admin, "nobody") == "user_absent"
            assert realm_access.turn_on(admin, "nobody") == "user_absent"
        assert ("GET", "/admin/realms/alpha/users/count") in kc.admin_calls()
        kc.override[("admin", "GET", "/admin/realms/alpha/users/count")] = (404, None)
        with admin_of(origins, source) as admin, pytest.raises(RealmCallError) as raised:
            realm_access.turn_off(admin, "nobody")
        assert raised.value.kind == "permanent", "a 404 realm read as an absent user"


# ------------------------------------------------------------ status classes ----


@pytest.mark.parametrize(
    ("status", "kind"),
    [
        (503, "ambiguous"),  # the logout is a write: it may be executing
        (429, "temporary"),  # refused before it was processed
        (400, "permanent"),
        (409, "permanent"),
        (403, "credential"),
        (302, "permanent"),
    ],
)
def test_each_answer_is_classified(source, status, kind):
    with keycloak_hosts() as (kc, origins):
        user_id = kc.add_user()
        path = f"/admin/realms/alpha/users/{user_id}/logout"
        kc.override[("admin", "POST", path)] = (
            status,
            "http://127.0.0.1:1/elsewhere" if status == 302 else {"error": "synthetic"},
        )
        with admin_of(origins, source) as admin, pytest.raises(RealmCallError) as raised:
            admin.logout(user_id)
        assert raised.value.kind == kind and raised.value.http_status == status
        assert kc.admin_calls() == [("POST", path)], "a redirect was followed"


def test_an_unreachable_keycloak_is_transport(source):
    origins = RealmOrigins(issuer="http://127.0.0.1:1", admin="http://127.0.0.1:1")
    with pytest.raises(RealmCallError) as raised, admin_of(origins, source):
        pass
    assert raised.value.kind == "transport"


# ---------------------------------------------------------------- the origins ----


@pytest.mark.parametrize(
    "value",
    [
        "http://auth.kodera.io",  # plaintext off loopback
        "https://user@auth.kodera.io",
        "https://auth.kodera.io?x=1",
        "https://auth.kodera.io#x",
        "ftp://auth.kodera.io",
        "",
    ],
)
def test_an_origin_setting_is_refused_unless_https_or_loopback(value):
    with pytest.raises(ValueError):
        keycloak.parse_origin(value)


def test_the_urls_come_from_the_pinned_origins_and_the_realm_name_only():
    origins = RealmOrigins(
        issuer=keycloak.parse_origin("https://auth.kodera.io/"),
        admin=keycloak.parse_origin("https://auth-admin.kodera.io/kc"),
    )
    assert keycloak.realm_urls("acme", origins) == (
        "https://auth.kodera.io/realms/acme/protocol/openid-connect/token",
        "https://auth-admin.kodera.io/kc/admin/realms/acme",
    )
    assert keycloak.realm_issuer("acme", origins) == "https://auth.kodera.io/realms/acme"
    with pytest.raises(RealmCallError):
        keycloak.realm_urls("../master", origins)


# ----------------------------------------------------------------- credentials ----


def test_a_credential_symlink_is_followed_only_inside_the_directory(tmp_path):
    secrets = tmp_path / "secrets"
    (secrets / "store").mkdir(parents=True)
    (secrets / "store" / "v1").write_text(SECRET)
    os.symlink(secrets / "store" / "v1", secrets / "alpha")
    (tmp_path / "outside").write_text(SECRET)
    os.symlink(tmp_path / "outside", secrets / "bravo")
    source = DirectoryCredentialSource(secrets)
    with source.load("alpha") as credential:
        assert credential.secret == SECRET and SECRET not in repr(credential)
    with pytest.raises(CredentialUnavailableError), source.load("bravo"):
        pass
    with pytest.raises(CredentialUnavailableError), source.load(".."):
        pass


# ------------------------------------------------------------------ deploy path ----


def test_the_operator_profile_migrates_the_outbox_and_the_image_carries_the_enqueue():
    """Core's schema is migrated operator-side under config.settings.job_queue (the image carries
    no migration: dev/accept_production_http.py, CUSTOMER_HTTP_RUNTIME.md), and that profile's
    plan reaches outbox 0005, the realm access payload, so the deploy path creates it."""
    program = (
        "import django; django.setup()\n"
        "from django.db.migrations.loader import MigrationLoader\n"
        "loader = MigrationLoader(None, ignore_no_migrations=True)\n"
        "print(('outbox', '0005_realm_access') in loader.graph.nodes)\n"
    )
    result = subprocess.run(  # noqa: S603 - fixed probe
        [sys.executable, "-c", program],
        cwd=ROOT,
        env={
            "PATH": os.environ.get("PATH", ""),
            "PYTHONPATH": str(ROOT),
            "DJANGO_SETTINGS_MODULE": "config.settings.job_queue",
            "DATABASE_URL": "postgres://probe:probe@127.0.0.1:1/kodera_server",
        },
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert result.stdout.strip() == "True", result.stderr[-2000:]
    ignore = (ROOT / ".dockerignore").read_text().splitlines()
    assert "!apps/outbox/realm_enqueue.py" in ignore
    assert not any(line.startswith("!apps/outbox/migrations") for line in ignore)


# ---------------------------------------------- the operator's realm read and the report ----


def test_a_realm_read_observes_state_and_decides_what_was_reached(source):
    with keycloak_hosts() as (kc, origins):
        user_id = kc.add_user()
        with admin_of(origins, source) as admin:
            live = realm_access.observe(admin, user_id)
            assert live == realm_access.RealmState(present=True, enabled=True, sessions=1, grants=2)
            assert not realm_access.reached("access_off", live)
            assert realm_access.reached("access_on", live)
            realm_access.turn_off(admin, user_id)
            off = realm_access.observe(admin, user_id)
            assert realm_access.reached("access_off", off)
            assert not realm_access.reached("access_on", off)
            gone = realm_access.observe(admin, "nobody")
            assert not gone.present and realm_access.reached("access_off", gone)
        assert ("GET", "/admin/realms/alpha/users/count") in kc.admin_calls()
    disabled_with_a_grant = realm_access.RealmState(
        present=True, enabled=False, sessions=0, grants=1
    )
    assert not realm_access.reached("access_off", disabled_with_a_grant), (
        "an offline grant left was read as off"
    )


@pytest.mark.parametrize("field", ["reconciliation", "late", "outstanding", "credential", "failed"])
def test_each_unknown_or_stuck_count_needs_an_operator(field):
    report = realm_access.RunReport(**{field: 1})
    assert report.needs_operator, f"{field} did not need an operator"
    assert "oldest_outstanding_s=0" in realm_access.RunReport().line()
    assert not realm_access.RunReport(
        withdrawn=1, held=1, user_absent=1, succeeded=1
    ).needs_operator


@pytest.mark.parametrize("deferral", [1, 2, 5, 20])
def test_a_retry_never_starts_before_a_timed_out_request_could_still_land(monkeypatch, deferral):
    monkeypatch.setattr(realm_access, "jitter", lambda upper: 0.0)
    assert realm_access.backoff_s(deferral) > keycloak.TIMEOUT_S, (
        "a retry could overlap a request Keycloak may still be processing"
    )
    monkeypatch.setattr(realm_access, "jitter", lambda upper: upper)
    assert realm_access.backoff_s(deferral) <= realm_access.BACKOFF_CAP_S + keycloak.TIMEOUT_S + 5


# ------------------------------------------- ambiguous writes and inconsistent 404s ----


def claim_of(user_id: str, operation: str = "access_off") -> realm_access.Claimed:
    import uuid

    return realm_access.Claimed(
        delivery_id=uuid.uuid4(),
        organisation_id=uuid.uuid4(),
        attempt_id=uuid.uuid4(),
        seq=1,
        operation=operation,
        realm="alpha",
        realm_user_id=user_id,
    )


def factory_of(source, origins):
    def factory(target, deadline=None):
        return keycloak.keycloak_admin(target, source=source, origins=origins, deadline=deadline)

    return factory


@pytest.mark.parametrize(
    ("method", "tail", "status"),
    [
        ("PUT", "", 504),
        ("PUT", "", 500),
        ("POST", "/logout", 502),
        ("DELETE", "/consents/console", 503),
    ],
)
def test_a_write_answered_by_a_server_error_has_an_unknown_outcome(source, method, tail, status):
    with keycloak_hosts() as (kc, origins):
        user_id = kc.add_user()
        kc.override[("admin", method, f"/admin/realms/alpha/users/{user_id}{tail}")] = (
            status,
            None,
        )
        outcome = realm_access.perform(claim_of(user_id), factory_of(source, origins))
        assert (outcome.attempt, outcome.reason) == ("ambiguous", "outcome_unknown"), (
            "a write that may have reached Keycloak was classified as retryable"
        )


def test_a_write_that_times_out_has_an_unknown_outcome(source, monkeypatch):
    monkeypatch.setattr(keycloak, "TIMEOUT_S", 0.3)
    with keycloak_hosts() as (kc, origins):
        user_id = kc.add_user()
        kc.delay[("admin", "PUT", f"/admin/realms/alpha/users/{user_id}")] = 1.0
        outcome = realm_access.perform(claim_of(user_id), factory_of(source, origins))
        assert outcome.attempt == "ambiguous"
        time.sleep(1.0)
        assert kc.users[user_id]["enabled"] is False  # the server finished the write anyway


def test_a_read_answered_by_a_server_error_stays_retryable(source):
    with keycloak_hosts() as (kc, origins):
        user_id = kc.add_user()
        kc.override[("admin", "GET", f"/admin/realms/alpha/users/{user_id}")] = (503, None)
        outcome = realm_access.perform(claim_of(user_id), factory_of(source, origins))
        assert (outcome.attempt, outcome.reason) == ("temporary", "temporary")


def test_an_unknown_failure_has_an_unknown_outcome():
    def broken(target, deadline=None):
        raise ZeroDivisionError

    outcome = realm_access.perform(claim_of("anyone"), broken)
    assert outcome.attempt == "ambiguous"


def test_a_put_404_while_the_user_reads_back_is_an_operator_failure_not_absence(source):
    with keycloak_hosts() as (kc, origins):
        user_id = kc.add_user()
        kc.override[("admin", "PUT", f"/admin/realms/alpha/users/{user_id}")] = (404, None)
        outcome = realm_access.perform(claim_of(user_id), factory_of(source, origins))
        assert (outcome.attempt, outcome.reason) == ("permanent", "not_found_inconsistent"), (
            "an existing user was certified absent from a write's 404"
        )
        assert kc.users[user_id]["enabled"] is True


class _VanishingAdmin:
    """A user who exists at the first read and is deleted before the logout."""

    def __init__(self, *, count_answers: bool) -> None:
        self.reads = 0
        self.count_answers = count_answers

    def get_user(self, user_id):
        self.reads += 1
        return {"id": user_id, "enabled": False} if self.reads == 1 else None

    def set_enabled(self, user_id, enabled):
        raise AssertionError("no write is due: the user is already disabled")

    def logout(self, user_id):
        raise keycloak.RealmUserAbsentError()

    def count_users(self):
        if not self.count_answers:
            raise RealmCallError("permanent", http_status=404)
        return 3


@pytest.mark.parametrize(("count_answers", "attempt"), [(True, "accepted"), (False, "permanent")])
def test_a_subresource_404_is_absence_only_when_the_user_and_the_realm_say_so(
    count_answers, attempt
):
    @contextmanager
    def factory(target, deadline=None):
        yield _VanishingAdmin(count_answers=count_answers)

    outcome = realm_access.perform(claim_of("vanishing"), factory)
    assert outcome.attempt == attempt
    if attempt == "accepted":
        assert outcome.reason == "user_absent"


# ------------------------------------------------- what left the client, and when ----


def test_a_tls_error_once_a_write_started_sending_is_ambiguous(source, monkeypatch):
    import ssl

    original = keycloak._DeadlineSocket.sendall

    def sendall(self, data):
        if isinstance(data, bytes) and data.startswith(b"PUT "):
            self.started_sending = True  # the first bytes are on their way when TLS fails
            raise ssl.SSLEOFError("EOF occurred in violation of protocol")
        return original(self, data)

    monkeypatch.setattr(keycloak._DeadlineSocket, "sendall", sendall)
    with keycloak_hosts() as (kc, origins):
        user_id = kc.add_user()
        outcome = realm_access.perform(claim_of(user_id), factory_of(source, origins))
        assert (outcome.attempt, outcome.reason) == ("ambiguous", "outcome_unknown"), (
            "a write whose bytes may have left was classified as never sent"
        )


def test_a_tls_handshake_failure_before_a_write_is_retryable(source, monkeypatch):
    import ssl

    with keycloak_hosts() as (kc, origins):
        user_id = kc.add_user()
        with admin_of(origins, source) as admin:
            original = keycloak._open

            def refused(url, end):
                raise ssl.SSLCertVerificationError("certificate verify failed")

            monkeypatch.setattr(keycloak, "_open", refused)
            with pytest.raises(RealmCallError) as raised:
                admin.set_enabled(user_id, False)
            monkeypatch.setattr(keycloak, "_open", original)
        assert raised.value.kind == "transport", "a write that never left was held as unknown"
        assert ("PUT", f"/admin/realms/alpha/users/{user_id}") not in kc.admin_calls()


def test_a_real_tls_handshake_against_a_plaintext_server_fails_before_sending(source):
    with keycloak_hosts() as (kc, origins):
        tls = RealmOrigins(
            issuer=origins.issuer.replace("http://", "https://"), admin=origins.admin
        )
        with pytest.raises(RealmCallError) as raised, admin_of(tls, source):
            pass
        assert raised.value.kind == "transport"
        assert kc.requests == [], "a request was parsed although the handshake failed"


# ---------------------------------------------------------- deadlines and bulk listing ----


def test_a_body_trickled_within_each_socket_timeout_still_hits_the_deadline(source, monkeypatch):
    monkeypatch.setattr(keycloak, "TIMEOUT_S", 0.5)
    with keycloak_hosts() as (kc, origins):
        user_id = kc.add_user()
        kc.trickle[("admin", "GET", f"/admin/realms/alpha/users/{user_id}/sessions")] = 0.05
        with admin_of(origins, source) as admin:
            started = time.monotonic()
            with pytest.raises(RealmCallError) as raised:
                admin.sessions(user_id)
            elapsed = time.monotonic() - started
        assert raised.value.kind == "temporary"
        assert elapsed < 1.5, f"a trickled body held the call for {elapsed:.1f}s past its deadline"


def test_a_run_deadline_bounds_a_listing_below_the_call_timeout(source):
    with keycloak_hosts() as (kc, origins):
        kc.add_user()
        kc.trickle[("admin", "GET", "/admin/realms/alpha/users")] = 0.05
        with admin_of(origins, source) as admin:
            started = time.monotonic()
            with pytest.raises(RealmCallError):
                admin.enabled_user_ids(deadline=time.monotonic() + 0.3)
            assert time.monotonic() - started < 1.0


def test_the_enabled_users_of_a_realm_are_listed_in_full_pages(source, monkeypatch):
    monkeypatch.setattr(keycloak, "LIST_PAGE", 2)
    with keycloak_hosts() as (kc, origins):
        for index in range(5):
            kc.add_user(f"user-{index}")
        kc.users["user-3"]["enabled"] = False
        with admin_of(origins, source) as admin:
            assert admin.enabled_user_ids() == {"user-0", "user-1", "user-2", "user-4"}
        pages = [r for r in kc.admin_calls() if r == ("GET", "/admin/realms/alpha/users")]
        assert len(pages) == 3  # 2 + 2 + 0, the last short page ends the listing


# ------------------------------------------------- a delivery stops between its calls ----


class _ClockedAdmin:
    """A realm user whose calls each take `step` seconds, and that records them."""

    def __init__(self, step: float) -> None:
        self.step = step
        self.calls: list[str] = []
        self.enabled = True

    def _call(self, name: str) -> None:
        self.calls.append(name)
        time.sleep(self.step)

    def get_user(self, user_id):
        self._call("get_user")
        return {"id": user_id, "enabled": self.enabled}

    def set_enabled(self, user_id, enabled):
        self._call("set_enabled")
        self.enabled = enabled

    def logout(self, user_id):
        self._call("logout")

    def consents(self, user_id):
        self._call("consents")
        return []

    def revoke_consent(self, user_id, client_id):
        self._call("revoke_consent")

    def sessions(self, user_id):
        self._call("sessions")
        return []

    def count_users(self):
        self._call("count_users")
        return 1


def test_a_delivery_past_its_deadline_starts_no_further_call():
    admin = _ClockedAdmin(step=0.2)

    @contextmanager
    def factory(target, deadline=None):
        yield admin

    outcome = realm_access.perform(claim_of("someone"), factory, deadline=time.monotonic() + 0.3)
    # get_user (0.2 s), set_enabled starts before the deadline (0.4 s), then nothing more.
    assert admin.calls == ["get_user", "set_enabled"], admin.calls
    assert (outcome.attempt, outcome.reason) == ("transport", "deadline"), (
        "a delivery kept calling Keycloak past its phase"
    )


def test_a_delivery_already_past_its_deadline_calls_nothing():
    admin = _ClockedAdmin(step=0.0)

    @contextmanager
    def factory(target, deadline=None):
        yield admin

    outcome = realm_access.perform(claim_of("someone"), factory, deadline=time.monotonic() - 1)
    assert admin.calls == [] and outcome.reason == "deadline"


# ------------------------------------------------------------------- the run lock ----


@pytest.mark.parametrize(
    ("age_s", "verdict"),
    [(None, "already_running"), (5.0, "already_running"), (10_000.0, "stuck_run")],
)
def test_a_held_run_lock_is_reported_stuck_only_past_twice_the_run_bound(age_s, verdict):
    assert realm_access.STUCK_RUN_AFTER_S == 2 * realm_access.RUN_BOUND_S
    assert realm_access.run_lock_verdict(age_s) == verdict


def test_a_failed_unlock_never_hides_the_error_that_ended_the_run(monkeypatch, caplog):
    from django.db import OperationalError

    monkeypatch.setattr(realm_access, "_rows", lambda statement, parameters=None: [(True,)])

    def unlock(statement, parameters=None):
        raise OperationalError("server closed the connection unexpectedly")

    def broken_run(**kwargs):
        raise ValueError("the original failure")

    monkeypatch.setattr(realm_access, "_execute", unlock)
    monkeypatch.setattr(realm_access, "_run", broken_run)
    with pytest.raises(ValueError, match="the original failure"):
        realm_access.run_realm_deliveries(
            admin_factory=None, organisation_lock=None, origins_issuer="https://x.test"
        )
    assert "run lock" in caplog.text


# ---------------------------------------------- the deadline covers the connection too ----


def test_a_slow_handshake_hits_the_deadline_and_sends_no_request(monkeypatch):
    monkeypatch.setattr(keycloak, "TIMEOUT_S", 0.3)
    with byte_recorder() as (received, port):  # accepts, never answers the TLS handshake
        started = time.monotonic()
        with pytest.raises(RealmCallError) as raised:
            keycloak._request(
                "PUT",
                f"https://127.0.0.1:{port}/admin/realms/alpha/users/x",
                headers={},
                body=b"{}",
            )
        elapsed = time.monotonic() - started
        time.sleep(0.5)
    assert raised.value.kind == "transport", "a write that never left was held as unknown"
    assert elapsed < 0.8, f"the handshake held the call for {elapsed:.1f}s past its deadline"
    assert b"PUT" not in b"".join(received), "a request was sent"


def test_a_slow_dns_lookup_hits_the_deadline_and_sends_nothing(monkeypatch):
    import socket as sockets

    original = sockets.getaddrinfo

    def slow(*args, **kwargs):
        time.sleep(1.0)
        return original(*args, **kwargs)

    monkeypatch.setattr(keycloak, "TIMEOUT_S", 0.3)
    with byte_recorder() as (received, port):
        monkeypatch.setattr(sockets, "getaddrinfo", slow)
        started = time.monotonic()
        with pytest.raises(RealmCallError) as raised:
            keycloak._request(
                "PUT", f"http://127.0.0.1:{port}/admin/realms/alpha/users/x", headers={}, body=b"{}"
            )
        elapsed = time.monotonic() - started
        time.sleep(1.2)  # the abandoned lookup finishes; nothing may follow it
        monkeypatch.setattr(sockets, "getaddrinfo", original)
    assert raised.value.kind == "transport" and elapsed < 0.8
    assert received == [], "a request followed an abandoned lookup"


def test_an_already_expired_deadline_sends_nothing(source):
    with keycloak_hosts() as (kc, origins):
        before = len(kc.requests)
        with pytest.raises(RealmCallError) as raised:
            keycloak._request(
                "GET",
                origins.admin + "/admin/realms/alpha/users/count",
                headers={},
                deadline=time.monotonic() - 1,
            )
        assert raised.value.kind == "transport" and len(kc.requests) == before


def test_the_token_request_honours_the_deadline(source, monkeypatch):
    with keycloak_hosts() as (kc, origins):
        kc.delay[("public", "POST", "/realms/alpha/protocol/openid-connect/token")] = 1.0
        started = time.monotonic()
        with pytest.raises(RealmCallError):
            with keycloak.keycloak_admin(
                RealmTarget("alpha"),
                source=source,
                origins=origins,
                deadline=time.monotonic() + 0.3,
            ):
                pass
        assert time.monotonic() - started < 0.8


# ------------------------------------------------------ the correction phase's slice ----


@pytest.mark.parametrize("overrun", [0.0, 1.0])
def test_corrections_keep_their_slice_whatever_the_earlier_phases_overrun(overrun):
    """Each phase may overrun its end by at most one call (CALL_OVERRUN_S); the windows are laid
    out from the run's start so that corrections still get CORRECTION_PHASE_S."""
    delivery_end, verify_end, correction_end = realm_access.phase_ends(0.0)
    started_verifying = delivery_end + overrun * realm_access.CALL_OVERRUN_S
    started_correcting = verify_end + overrun * realm_access.CALL_OVERRUN_S
    assert verify_end - started_verifying >= realm_access.VERIFY_PHASE_S
    assert correction_end - started_correcting >= realm_access.CORRECTION_PHASE_S
    assert correction_end == realm_access.RUN_DEADLINE_S


# ----------------------------------- no request outlives its call, and none is sent late ----


@contextmanager
def byte_recorder() -> Iterator[tuple[list[bytes], int]]:
    """A TCP server that answers nothing and records every byte any connection sent it."""
    import socketserver

    received: list[bytes] = []

    class Handler(socketserver.BaseRequestHandler):
        def handle(self) -> None:
            self.request.settimeout(3.0)
            try:
                while True:
                    data = self.request.recv(65536)
                    if not data:
                        return
                    received.append(data)
            except OSError:
                return

    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield received, server.server_address[1]
    finally:
        server.shutdown()
        server.server_close()


def test_a_pause_before_the_send_past_the_deadline_never_sends(monkeypatch):
    import http.client

    original = http.client.HTTPConnection.request

    def paused(self, *args, **kwargs):
        time.sleep(0.6)  # the calling side is descheduled just before the first byte
        return original(self, *args, **kwargs)

    monkeypatch.setattr(keycloak, "TIMEOUT_S", 0.3)
    monkeypatch.setattr(http.client.HTTPConnection, "request", paused)
    with byte_recorder() as (received, port):
        with pytest.raises(RealmCallError) as raised:
            keycloak._request(
                "PUT", f"http://127.0.0.1:{port}/admin/realms/alpha/users/x", headers={}, body=b"{}"
            )
        time.sleep(1.0)  # long enough for any leftover sender to resume and write
        assert received == [], "a request was sent after its deadline"
    assert raised.value.kind == "transport", "a request that never left was held as unknown"


def test_a_connection_ready_only_after_the_deadline_never_writes(monkeypatch):
    import socket as sockets

    original = sockets.socket.connect

    def slow(self, address):
        time.sleep(0.6)
        return original(self, address)

    monkeypatch.setattr(keycloak, "TIMEOUT_S", 0.3)
    with byte_recorder() as (received, port):
        monkeypatch.setattr(sockets.socket, "connect", slow)
        with pytest.raises(RealmCallError) as raised:
            keycloak._request(
                "PUT", f"http://127.0.0.1:{port}/admin/realms/alpha/users/x", headers={}, body=b"{}"
            )
        monkeypatch.setattr(sockets.socket, "connect", original)
        time.sleep(1.0)
        assert received == [], "a connection set up after its deadline wrote"
    assert raised.value.kind == "transport"


def test_no_request_thread_outlives_its_call(source, monkeypatch):
    monkeypatch.setattr(keycloak, "TIMEOUT_S", 0.3)

    def request_threads():
        return [
            t
            for t in threading.enumerate()
            if getattr(getattr(t, "_target", None), "__module__", None) == keycloak.__name__
        ]

    with keycloak_hosts() as (kc, origins):
        user_id = kc.add_user()
        kc.trickle[("admin", "GET", f"/admin/realms/alpha/users/{user_id}/sessions")] = 0.05
        with admin_of(origins, source) as admin:
            with pytest.raises(RealmCallError):
                admin.sessions(user_id)
            assert request_threads() == [], "a request thread outlived its call"


def test_a_connection_refuses_to_reconnect():
    import http.client

    with byte_recorder() as (_, port):
        used = keycloak._Connection("127.0.0.1", port)
        used.connect()
        used.close()
        with pytest.raises(OSError, match="reconnect"):
            used.connect()
        unopened = keycloak._Connection("127.0.0.1", port)
        with pytest.raises(http.client.NotConnected):  # no implicit open: auto_open is off
            unopened.request("GET", "/")


# ------------------------------------------------------------- the Host header's port ----


@pytest.mark.parametrize(
    ("url", "host"),
    [
        (
            "https://auth-admin.example.test/admin/realms/a/users",
            b"Host: auth-admin.example.test\r\n",
        ),
        (
            "https://auth-admin.example.test:8443/admin/realms/a/users",
            b"Host: auth-admin.example.test:8443\r\n",
        ),
        ("http://127.0.0.1:8080/admin/realms/a/users", b"Host: 127.0.0.1:8080\r\n"),
    ],
)
def test_the_host_header_names_a_port_only_when_it_is_not_the_schemes_default(
    monkeypatch, url, host
):
    import socket as sockets
    import urllib.parse as parse

    ours, theirs = sockets.socketpair()
    theirs.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n[]")

    def opened(target_url, end):
        parts = parse.urlsplit(target_url)
        port = parts.port or (443 if parts.scheme == "https" else 80)
        return keycloak._DeadlineSocket(ours, end), parts.path, parts.hostname, port, parts.scheme

    monkeypatch.setattr(keycloak, "_open", opened)
    assert keycloak._request("GET", url, headers={})[0] == 200
    sent = theirs.recv(65536)
    theirs.close()
    assert host in sent, sent
