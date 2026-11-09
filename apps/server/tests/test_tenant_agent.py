"""The tenant agent (ADR-0016), with Core, Docker and LiveKit replaced by fakes.

`tenant_agent/README.md` runs the same agent against the real engines of the engine spike.
"""

import ast
import base64
import hashlib
import json
import time
import urllib.parse
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
import pytest

from tenant_agent import engines
from tenant_agent.agent import Agent
from tenant_agent.config import Config, ConfigError
from tenant_agent.core_api import CommandGoneError
from tenant_agent.docker_exec import DockerExec, ExecError, ExecResult
from tenant_agent.engines import Docs, Meet
from tenant_agent.guard import RosterGuard
from tenant_agent.handlers import MEMBER_KIND, Handlers
from tenant_agent.state import State
from tenant_agent.webhook import verify

ALICE, BOB, CAROL, GUEST, ROOT = "sub-alice", "sub-bob", "sub-carol", "guest-7f3a", "sub-root"


class FakeEngine:
    """One Django engine's users: subject -> is_active."""

    def __init__(self) -> None:
        self.users = {ALICE: True, BOB: True, CAROL: True, ROOT: True}
        self.sessions = {ALICE: 1, BOB: 2, CAROL: 1, ROOT: 1}


class FakeRunner:
    """Runs the engine snippets the way the engines would, on FakeEngine state."""

    def __init__(self) -> None:
        self.engines = {"docs-backend": FakeEngine(), "meet-backend": FakeEngine()}
        self.files: dict[str, bytes] = {}
        self.calls: list[str] = []
        self.fail: str | None = None

    def exists(self, service: str) -> bool:
        return service in self.engines

    def put_file(self, service: str, name: str, content: bytes) -> str:
        path = f"container:/{name}"
        self.files[path] = content
        return path

    def run(self, service: str, argv: list[str], env: dict[str, str]) -> ExecResult:
        code = argv[-1]
        self.calls.append(service)
        if self.fail == service:
            return ExecResult(1, "Traceback: boom")
        engine = self.engines[service]
        if code in (engines.DOCS_CONVERGE, engines.MEET_CONVERGE):
            wanted = json.loads(self.files.pop(env["AGENT_INPUT"]))
            inactive, released = set(wanted["inactive"]), set(wanted["released"])
            newly = [s for s in inactive if engine.users.get(s)]
            for s in newly:
                engine.users[s] = False
            closing = (
                [s for s in inactive if engine.users.get(s) is False]
                if env["AGENT_FULL"] == "1"
                else newly
            )
            back = [s for s in released - inactive if engine.users.get(s) is False]
            for s in back:
                engine.users[s] = True
            dropped = sum(engine.sessions.pop(s, 0) for s in closing)
            answer = {
                "deactivated": len(newly),
                "reactivated": len(back),
                "sessions_dropped": dropped,
                "documents_kicked": 3 * len(closing) if code == engines.DOCS_CONVERGE else 0,
            }
            # As a TTY exec answers: the shell's colour codes before the marker.
            return ExecResult(0, "noise\n\x1b[0m" + engines.RESULT_MARKER + json.dumps(answer))
        if code == engines.MEET_DEACTIVATED:
            asked = [i for i in env["AGENT_IDENTITIES"].split(",") if i]
            found = sorted(i for i in asked if engine.users.get(i) is False)
            return ExecResult(0, engines.RESULT_MARKER + json.dumps({"deactivated": found}))
        raise AssertionError("unexpected engine code")


class FakeLiveKit:
    def __init__(self, rooms: dict[str, list[str]]) -> None:
        self.rooms_ = rooms
        self.removed: list[tuple[str, str]] = []

    def rooms(self) -> list[str]:
        return list(self.rooms_)

    def participants(self, room: str) -> list[dict[str, Any]]:
        return [
            {"identity": i, "attributes": {"is_authenticated": "true"}} for i in self.rooms_[room]
        ]

    def remove(self, room: str, identity: str) -> None:
        self.removed.append((room, identity))
        self.rooms_[room] = [i for i in self.rooms_[room] if i != identity]


class FakeApi:
    def __init__(self, commands: list[dict[str, Any]], gone: set[str] | None = None) -> None:
        self.commands_, self.gone = commands, gone or set()
        self.acked: list[str] = []
        self.results: list[tuple[str, dict[str, Any]]] = []

    def commands(self, kinds: tuple[str, ...], wait_s: int) -> list[dict[str, Any]]:
        assert kinds == (MEMBER_KIND,)  # no Synapse on this VM: Handlers.kinds
        return list(self.commands_)

    def ack(self, command_id: str) -> dict[str, Any]:
        if command_id in self.gone:
            raise CommandGoneError(command_id)
        self.acked.append(command_id)
        return {"command_id": command_id, "status": "accepted", "cancelled": False}

    def result(self, command_id: str, outcome: dict[str, Any]) -> None:
        self.results.append((command_id, outcome))


def member_set(
    revision: int, *, active=(ALICE, CAROL), inactive=(BOB,), released=()
) -> dict[str, Any]:
    return {
        "revision": revision,
        "active_subjects": sorted(active),
        "inactive_subjects": sorted(inactive),
        "released_subjects": sorted(released),
    }


def command(
    payload: dict[str, Any],
    *,
    command_id: str = "c0ffee00-1111-4222-8333-444455556666",
    expired: bool = False,
) -> dict[str, Any]:
    expires = datetime.now(UTC) + (timedelta(minutes=-1) if expired else timedelta(hours=1))
    return {
        "command_id": command_id,
        "kind": "engine_set_member_subjects",
        "payload": payload,
        "attempt": 1,
        "issued_at": datetime.now(UTC).isoformat(),
        "expires_at": expires.isoformat(),
    }


def build(tmp_path: Any, livekit: FakeLiveKit, runner: FakeRunner | None = None):
    runner = runner or FakeRunner()
    state = State(tmp_path)
    meet = Meet(runner, "meet-backend")
    guard = RosterGuard(livekit, meet, state)  # type: ignore[arg-type]
    return Handlers(Docs(runner, "docs-backend"), meet, guard, state), runner, state


def test_a_set_deactivates_inactive_subjects_everywhere_and_touches_no_one_else(tmp_path):
    livekit = FakeLiveKit({"room-r": [ALICE, BOB], "room-t": [BOB]})
    handlers, runner, state = build(tmp_path, livekit)
    api = FakeApi([command(member_set(3))])

    assert Agent(api, handlers, state).poll_once() == 1

    for engine in runner.engines.values():
        assert engine.users == {ALICE: True, BOB: False, CAROL: True, ROOT: True}
        assert BOB not in engine.sessions and engine.sessions[ROOT] == 1
    assert sorted(livekit.removed) == [("room-r", BOB), ("room-t", BOB)]
    command_id, outcome = api.results[0]
    assert (command_id, outcome["status"]) == ("c0ffee00-1111-4222-8333-444455556666", "succeeded")
    assert outcome["artefacts"] == {
        "revision_applied": 3,
        "users_deactivated": 2,
        "users_reactivated": 0,
        "documents_kicked": 3,
        "participants_removed": 2,
    }
    assert state.result("c0ffee00-1111-4222-8333-444455556666") == outcome
    assert runner.files == {}  # every uploaded set was consumed


def test_a_released_subject_is_reactivated_and_an_engine_admin_s_own_deactivation_stands(tmp_path):
    handlers, runner, _ = build(tmp_path, FakeLiveKit({}))
    for engine in runner.engines.values():
        engine.users[CAROL] = False  # an engine administrator's own decision, unknown to Core
    handlers.handle("engine_set_member_subjects", member_set(1, active=(ALICE,), inactive=(BOB,)))

    outcome = handlers.handle(
        "engine_set_member_subjects",
        member_set(2, active=(ALICE, BOB), inactive=(), released=(BOB,)),
    )

    assert outcome.artefacts["users_reactivated"] == 2
    for engine in runner.engines.values():
        assert engine.users[BOB] is True and engine.users[CAROL] is False


def test_an_older_revision_never_undoes_a_newer_one(tmp_path):
    handlers, runner, state = build(tmp_path, FakeLiveKit({}))
    handlers.handle("engine_set_member_subjects", member_set(7))

    outcome = handlers.handle(
        "engine_set_member_subjects",
        member_set(6, active=(ALICE, BOB), inactive=(), released=(BOB,)),
    )

    assert outcome.status == "succeeded" and outcome.artefacts["revision_applied"] == 7
    assert state.member_set().revision == 7
    assert all(engine.users[BOB] is False for engine in runner.engines.values())


def test_reapply_converges_an_engine_restored_behind_the_set(tmp_path):
    handlers, runner, _ = build(tmp_path, FakeLiveKit({}))
    assert handlers.reapply() is None  # nothing in force yet
    handlers.handle("engine_set_member_subjects", member_set(1))
    runner.engines["docs-backend"].users[BOB] = True  # a restore brought him back

    outcome = handlers.reapply()

    assert outcome.status == "succeeded" and runner.engines["docs-backend"].users[BOB] is False


def test_a_command_delivered_twice_is_applied_once_and_its_result_replayed(tmp_path):
    handlers, runner, state = build(tmp_path, FakeLiveKit({}))
    api = FakeApi([command(member_set(1))])
    agent = Agent(api, handlers, state)
    agent.poll_once()
    calls = len(runner.calls)

    agent.poll_once()

    assert len(runner.calls) == calls
    assert (
        api.acked == ["c0ffee00-1111-4222-8333-444455556666"] and api.results[1] == api.results[0]
    )


def test_a_command_core_answers_409_on_is_not_executed(tmp_path):
    handlers, runner, state = build(tmp_path, FakeLiveKit({}))
    api = FakeApi([command(member_set(1))], gone={"c0ffee00-1111-4222-8333-444455556666"})

    assert Agent(api, handlers, state).poll_once() == 0
    assert runner.calls == [] and api.results == []


def test_an_expired_command_is_not_started(tmp_path):
    handlers, runner, state = build(tmp_path, FakeLiveKit({}))
    api = FakeApi([command(member_set(1), expired=True)])

    Agent(api, handlers, state).poll_once()

    assert runner.calls == [] and api.results[0][1]["error_code"] == "expired"


@pytest.mark.parametrize(
    ("kind", "payload", "code"),
    [
        ("engine_set_member_subjects", {}, "invalid_payload"),
        ("engine_set_member_subjects", {**member_set(1), "revision": 0}, "invalid_payload"),
        ("engine_set_member_subjects", {**member_set(1), "revision": True}, "invalid_payload"),
        (
            "engine_set_member_subjects",
            {**member_set(1), "inactive_subjects": ["has space"]},
            "invalid_payload",
        ),
        (
            "engine_set_member_subjects",
            {**member_set(1), "released_subjects": None},
            "invalid_payload",
        ),
        (
            "engine_set_member_subjects",
            member_set(1, active=(ALICE,), inactive=(ALICE,)),
            "invalid_payload",
        ),
        (
            "engine_set_member_subjects",
            {**member_set(1), "active_subjects": [f"s{i}" for i in range(10_001)]},
            "invalid_payload",
        ),
        ("upgrade", {}, "unsupported_kind"),
    ],
)
def test_malformed_or_unknown_commands_fail_with_their_code_and_touch_nothing(
    tmp_path, kind, payload, code
):
    handlers, runner, state = build(tmp_path, FakeLiveKit({}))

    outcome = handlers.handle(kind, payload)

    assert (outcome.status, outcome.error_code) == ("failed", code)
    assert runner.calls == [] and state.member_set() is None


def test_an_engine_that_fails_reports_service_unhealthy(tmp_path):
    runner = FakeRunner()
    runner.fail = "meet-backend"
    handlers, _, _ = build(tmp_path, FakeLiveKit({}), runner)

    outcome = handlers.handle("engine_set_member_subjects", member_set(1))

    assert (outcome.status, outcome.error_code) == ("failed", "service_unhealthy")
    # The engine's output stays on the VM; Core gets the code and a pointer to the agent log.
    assert "Traceback" not in (outcome.detail or "") and "agent log" in (outcome.detail or "")


AGENT_ENV = {
    "KODERA_CORE_URL": "https://core.example",
    "KODERA_AGENT_TOKEN": "eac1_test",
    "KODERA_COMPOSE_PROJECT": "acme",
    "LIVEKIT_URL": "http://livekit:7880",
    "LIVEKIT_API_KEY": "acme",
    "LIVEKIT_API_SECRET": "not-a-secret",
}


def test_the_apps_a_tenant_runs_are_read_from_its_environment():
    def apps(value: str | None) -> frozenset[str]:
        extra = {} if value is None else {"KODERA_APPS": value}
        env = {**AGENT_ENV, "KODERA_AGENT_STATE_DIR": "/state", **extra}
        return Config.from_env(env).apps

    assert apps(None) == {"docs", "meet"}
    assert apps("meet") == {"meet"}
    assert apps(" docs , meet ") == {"docs", "meet"}
    with pytest.raises(ConfigError, match="unknown apps"):
        apps("meet,chat")
    # No app at all would let every member set succeed having revoked nothing.
    for empty in ("", " , "):
        with pytest.raises(ConfigError, match="names no app"):
            apps(empty)


@pytest.mark.parametrize(("runs", "absent"), [("meet", "docs"), ("docs", "meet")])
def test_an_app_the_tenant_does_not_run_is_never_asked(tmp_path, monkeypatch, runs, absent):
    """A tenant without Docs (or Meet): its member sets converge the rest and succeed."""
    from tenant_agent import __main__ as main

    runner = FakeRunner()
    del runner.engines[f"{absent}-backend"]  # asking it would fail, as Docker's "no container"
    livekit = FakeLiveKit({"room-r": [ALICE, BOB]})
    monkeypatch.setattr(main, "DockerExec", lambda *args: runner)
    monkeypatch.setattr(main, "LiveKit", lambda *args: livekit)
    env = {**AGENT_ENV, "KODERA_AGENT_STATE_DIR": str(tmp_path), "KODERA_APPS": runs}
    agent, _, _ = main.build(Config.from_env(env))

    outcome = agent._handlers.handle(MEMBER_KIND, member_set(1))

    assert outcome.status == "succeeded", outcome
    assert set(runner.calls) == {f"{runs}-backend"}
    assert runner.engines[f"{runs}-backend"].users[BOB] is False
    assert livekit.removed == [("room-r", BOB)]


@pytest.mark.parametrize(("listed", "unlisted"), [("meet", "docs"), ("docs", "meet")])
def test_the_agent_refuses_to_start_when_the_tenant_runs_an_app_kodera_apps_omits(
    tmp_path, monkeypatch, listed, unlisted
):
    """An app left out of KODERA_APPS is never asked, so its accounts would outlive every
    revocation while the member sets report success. Its container, running or not, stops the
    agent at start, in every mode."""
    from tenant_agent import __main__ as main

    runner = FakeRunner()  # both engines' containers exist
    monkeypatch.setattr(main, "DockerExec", lambda *args: runner)
    env = {**AGENT_ENV, "KODERA_AGENT_STATE_DIR": str(tmp_path), "KODERA_APPS": listed}
    with pytest.raises(ConfigError, match=rf"runs \['{unlisted}'\], which KODERA_APPS does not"):
        main.build(Config.from_env(env))
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    assert main.main(["tenant_agent", "once"]) == 2
    assert runner.calls == []


def test_the_agent_refuses_to_start_when_it_cannot_tell_which_apps_run(tmp_path, monkeypatch):
    from tenant_agent import __main__ as main

    class Unreachable(FakeRunner):
        def exists(self, service: str) -> bool:
            raise ExecError("docker socket: refused")

    monkeypatch.setattr(main, "DockerExec", lambda *args: Unreachable())
    env = {**AGENT_ENV, "KODERA_AGENT_STATE_DIR": str(tmp_path), "KODERA_APPS": "meet"}
    with pytest.raises(ConfigError, match="cannot check which apps the tenant runs"):
        main.build(Config.from_env(env))


def test_a_container_counts_whether_or_not_it_runs():
    """A stopped Docs is still a Docs whose accounts a revocation must reach."""

    class Listing(DockerExec):
        def __init__(self, status: int, found: list[dict[str, Any]]) -> None:
            super().__init__("/nonexistent.sock", "acme")
            self.answer = (status, json.dumps(found).encode())
            self.paths: list[str] = []

        def _call(self, method, path, body=None):
            self.paths.append(path)
            return self.answer

    docker = Listing(200, [{"Id": "c1", "State": "exited"}])
    assert docker.exists("docs-backend") is True
    query = urllib.parse.parse_qs(docker.paths[0].split("?", 1)[1])
    assert query["all"] == ["1"]
    assert json.loads(query["filters"][0]) == {
        "label": ["com.docker.compose.project=acme", "com.docker.compose.service=docs-backend"]
    }
    assert Listing(200, []).exists("docs-backend") is False
    with pytest.raises(ExecError, match="answered 500"):
        Listing(500, []).exists("docs-backend")


def test_without_meet_the_guard_removes_inactive_subjects_only(tmp_path):
    runner = FakeRunner()
    livekit = FakeLiveKit({"room-r": [ALICE, CAROL]})
    state = State(tmp_path)
    guard = RosterGuard(livekit, None, state)
    state.keep(handlers_parse(member_set(1, active=(ALICE,), inactive=(CAROL,))))
    assert guard.enforce().removed == [("room-r", CAROL)] and runner.calls == []


class RecordingDocker(DockerExec):
    """Docker's Engine API as the exec sees it, for a container whose image declares `user`."""

    def __init__(self, user: str) -> None:
        super().__init__("/nonexistent.sock", "acme")
        self.user = user
        self.created: list[dict[str, Any]] = []

    def _call(self, method, path, body=None):
        if path.startswith("/containers/json"):
            return 200, json.dumps([{"Id": "c1"}]).encode()
        if path == "/containers/c1/json":
            return 200, json.dumps({"Config": {"User": self.user}}).encode()
        if path == "/containers/c1/exec":
            self.created.append(body)
            return 201, json.dumps({"Id": "e1"}).encode()
        if path == "/exec/e1/start":
            return 200, b"ok"
        return 200, json.dumps({"ExitCode": 0}).encode()


@pytest.mark.parametrize(
    ("declared", "exec_user"),
    [("1001:127:-1000", "1001:127"), ("1001:127", None), ("app", None), ("", None)],
)
def test_an_exec_runs_as_the_image_s_user_even_when_it_is_malformed(declared, exec_user):
    """Meet's image declares `1001:127:-1000`: an exec inheriting it exits 126 before it starts.
    A well-formed user is left to Docker, as before."""
    docker = RecordingDocker(declared)
    assert docker.run("meet-backend", ["true"], {}).exit_code == 0
    assert docker.created[0].get("User") == exec_user


def test_the_guard_removes_inactive_subjects_and_deactivated_users_and_keeps_meet_s_admissions(
    tmp_path,
):
    runner = FakeRunner()
    livekit = FakeLiveKit({"room-r": [ALICE, CAROL, BOB], "room-p": [ALICE, GUEST]})
    _, _, state = build(tmp_path, livekit, runner)
    guard = RosterGuard(livekit, Meet(runner, "meet-backend"), state)

    # Before any set, with nobody deactivated: nobody is second-guessed, lobby guests included.
    assert guard.enforce().removed == []
    # A user Meet holds deactivated is removed even before any set.
    runner.engines["meet-backend"].users[BOB] = False
    assert guard.enforce().removed == [("room-r", BOB)]
    # With a set: carol is inactive though Meet still holds her active.
    state.keep(handlers_parse(member_set(1, active=(ALICE,), inactive=(CAROL,))))
    assert guard.enforce().removed == [("room-r", CAROL)]
    assert livekit.rooms_ == {"room-r": [ALICE], "room-p": [ALICE, GUEST]}


def test_one_room_the_guard_cannot_check_does_not_stop_the_others(tmp_path):
    class FlakyLiveKit(FakeLiveKit):
        def participants(self, room: str) -> list[dict[str, Any]]:
            if room == "room-broken":
                raise engines.EngineError("livekit ListParticipants answered 500")
            return super().participants(room)

    livekit = FlakyLiveKit({"room-broken": [BOB], "room-r": [BOB]})
    handlers, _, _ = build(tmp_path, livekit)

    outcome = handlers.handle("engine_set_member_subjects", member_set(1))

    assert livekit.removed == [("room-r", BOB)]
    # The engines converged, but Core is told to retry: one room was not checked.
    assert (outcome.status, outcome.error_code) == ("failed", "service_unhealthy")


def test_reapply_never_reactivates_so_an_engine_admin_s_later_decision_stands(tmp_path):
    handlers, runner, _ = build(tmp_path, FakeLiveKit({}))
    handlers.handle(
        "engine_set_member_subjects",
        member_set(1, active=(ALICE, BOB), inactive=(), released=(BOB,)),
    )
    runner.engines["docs-backend"].users[BOB] = False  # an engine administrator's decision

    handlers.reapply()

    assert runner.engines["docs-backend"].users[BOB] is False


@pytest.mark.parametrize("expires", [None, "not a date", "2001-01-01T00:00:00"])
def test_a_command_without_a_readable_future_expiry_is_treated_as_expired(tmp_path, expires):
    handlers, runner, state = build(tmp_path, FakeLiveKit({}))
    cmd = command(member_set(1))
    if expires is None:
        del cmd["expires_at"]
    else:
        cmd["expires_at"] = expires
    api = FakeApi([cmd])

    Agent(api, handlers, state).poll_once()

    assert runner.calls == [] and api.results[0][1]["error_code"] == "expired"


def test_a_command_without_a_well_formed_id_is_ignored(tmp_path):
    handlers, runner, state = build(tmp_path, FakeLiveKit({}))
    api = FakeApi([command(member_set(1), command_id="../../etc/passwd")])

    assert Agent(api, handlers, state).poll_once() == 0
    assert runner.calls == [] and api.acked == []


def test_old_ledger_entries_are_pruned(tmp_path):
    import os

    state = State(tmp_path)
    state.record("c0ffee00-1111-4222-8333-444455556666", {"status": "succeeded"})
    old = tmp_path / "ledger" / "c0ffee00-1111-4222-8333-444455556666.json"
    os.utime(old, (time.time() - 31 * 24 * 3600,) * 2)
    state.record("c0ffee00-1111-4222-8333-444455556667", {"status": "succeeded"})

    assert state.prune() == 1
    assert state.result("c0ffee00-1111-4222-8333-444455556667") is not None


def handlers_parse(payload: dict[str, Any]):
    from tenant_agent.handlers import parse

    parsed = parse(payload)
    assert parsed is not None
    return parsed


def _signed(body: bytes, secret: str, key: str = "spikekey") -> str:
    digest = base64.b64encode(hashlib.sha256(body).digest()).decode()
    return jwt.encode(
        {"iss": key, "exp": int(time.time()) + 60, "sha256": digest}, secret, algorithm="HS256"
    )


def test_webhook_signature_is_verified_against_body_and_secret():
    body = json.dumps({"event": "participant_joined", "room": {"name": "room-r"}}).encode()
    token = _signed(body, "s" * 40)

    assert verify(body, token, "spikekey", "s" * 40)
    assert not verify(body + b" ", token, "spikekey", "s" * 40)
    assert not verify(body, token, "spikekey", "t" * 40)
    assert not verify(body, _signed(body, "s" * 40, key="other"), "spikekey", "s" * 40)


@pytest.mark.parametrize("snippet", ["DOCS_CONVERGE", "MEET_CONVERGE", "MEET_DEACTIVATED"])
def test_engine_snippets_are_valid_python_naming_the_upstream_symbols_they_rely_on(snippet):
    code = getattr(engines, snippet)
    ast.parse(code)
    pinned = {
        "DOCS_CONVERGE": [
            "reset_service_connections_on_commit",
            "LinkTrace",
            "DocumentAccess",
            "iter_keys",
            "cache_key_prefix",
            "is_active",
        ],
        "MEET_CONVERGE": ["Session.objects", "get_decoded", "is_active"],
        "MEET_DEACTIVATED": ["models.User", "is_active=False", "sub__in"],
    }[snippet]
    assert all(name in code for name in pinned)


def test_the_webhook_refuses_unbounded_unsigned_or_malformed_deliveries(tmp_path):
    import http.client
    import threading

    from tenant_agent.webhook import make_server

    livekit = FakeLiveKit({"room-r": [BOB]})
    _, runner, state = build(tmp_path, livekit)
    runner.engines["meet-backend"].users[BOB] = False
    guard = RosterGuard(livekit, Meet(runner, "meet-backend"), state)
    server = make_server("127.0.0.1", 0, guard, "spikekey", "s" * 40)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]

    def post(body: bytes, headers: dict[str, str]) -> int:
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            connection.request("POST", "/livekit/webhook", body=body, headers=headers)
            response = connection.getresponse()
            response.read()
            return response.status
        finally:
            connection.close()

    joined = json.dumps({"event": "participant_joined", "room": {"name": "room-r"}}).encode()
    try:
        assert post(joined, {"Authorization": "x"}) == 401
        assert post(b"x" * (64 * 1024 + 1), {"Authorization": _signed(b"", "s" * 40)}) == 413
        assert livekit.removed == []
        assert post(joined, {"Authorization": _signed(joined, "s" * 40)}) == 200
        assert livekit.removed == [("room-r", BOB)]
    finally:
        server.shutdown()
        server.server_close()
