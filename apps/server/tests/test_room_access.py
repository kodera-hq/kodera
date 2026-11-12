"""The room-access service (ADR-0018), with Synapse and LiveKit replaced by fakes. The real servers
are exercised by the E4 spike in design specification (`architecture/engine-spike/rooms/`)."""

import base64
import hashlib
import http.client
import io
import json
import socket
import threading
import time
import urllib.error
import urllib.request
from email.message import Message
from typing import Any
from unittest.mock import patch

import jwt
import pytest

from room_access import clients
from room_access.clients import LiveKit, Matrix, UpstreamError
from room_access.config import Config, ConfigError
from room_access.rooms import OCCUPANCY, POLICY, livekit_room
from room_access.server import make_token_server, make_webhook_server
from room_access.service import RefusedError, Service
from tenant_agent.synapse import livekit_room as agent_livekit_room

KEY, SECRET = "roomkey", "room-secret-for-tests-only-0123456789"
AUDIO, TEXT = "!audio:acme.kodera.io", "!text:acme.kodera.io"
ALICE, BOB, CAROL = "@alice:acme.kodera.io", "@bob:acme.kodera.io", "@carol:acme.kodera.io"
ROOM_ACCESS = "@room-access:acme.kodera.io"
AGENT = "@kodera-agent:acme.kodera.io"
TOKENS = {
    "tok-alice": (ALICE, "DEV1"),
    "tok-alice-2": (ALICE, "DEV2"),
    "tok-bob": (BOB, "B1"),
    "tok-carol": (CAROL, "C1"),
    "room-access-token": (ROOM_ACCESS, "RA"),
}
CONSOLE = "https://app.kodera.io"


class FakeMatrix(Matrix):
    def __init__(self) -> None:
        super().__init__("http://synapse:8008", "room-access-token")
        self.rooms: dict[str, dict[str, Any]] = {
            AUDIO: {
                "state": {
                    POLICY: {
                        "version": 1,
                        "kind": "audio",
                        "listen_only": False,
                        "may_publish": [],
                        "archived": False,
                    }
                },
                "joined": {ALICE, BOB, ROOM_ACCESS},
            },
            TEXT: {
                "state": {
                    POLICY: {
                        "version": 1,
                        "kind": "text",
                        "listen_only": False,
                        "may_publish": [],
                        "archived": False,
                    }
                },
                "joined": {ALICE, BOB},
            },
        }
        self.writes: list[dict[str, Any]] = []
        self.joined_reads = 0
        self.invites: list[str] = []
        self.inviters: list[str] = []
        self.senders: dict[tuple[str, str], str] = {}  # (room, event type) → sender, else AGENT
        self._lock = threading.Lock()

    def whoami(self, token):
        return TOKENS.get(token)

    def state(self, room_id, event_type):
        with self._lock:
            found = self.rooms.get(room_id, {}).get("state", {}).get(event_type)
            return dict(found) if found is not None else None

    def state_event(self, room_id, event_type):
        content = self.state(room_id, event_type)
        if content is None:
            return None
        with self._lock:
            sender = self.senders.get((room_id, event_type), AGENT)
        return {"type": event_type, "state_key": "", "sender": sender, "content": content}

    def membership(self, room_id, user_id):
        with self._lock:
            return "join" if user_id in self.rooms.get(room_id, {}).get("joined", set()) else None

    def joined_members(self, room_id):
        with self._lock:
            self.joined_reads += 1
            return set(self.rooms[room_id]["joined"])

    def put_state(self, room_id, event_type, content):
        with self._lock:
            self.rooms[room_id]["state"][event_type] = content
            self.writes.append(content)

    def accept_invites(self, inviter):
        with self._lock:
            self.inviters.append(inviter)
            joined, self.invites = self.invites, []
            return joined

    def policy(self, room_id, **changes):
        with self._lock:
            self.rooms[room_id]["state"][POLICY] = {
                **self.rooms[room_id]["state"][POLICY],
                **changes,
            }


class FakeLiveKit(LiveKit):
    def __init__(self) -> None:
        super().__init__("http://livekit:7880", KEY, SECRET)
        self.calls: dict[str, list[dict[str, Any]]] = {}  # LiveKit room → participants
        self.metadata: dict[str, str] = {}
        self.removed: list[str] = []
        self.updates: list[tuple[str, bool]] = []
        self._lock = threading.Lock()

    def create_room(self, name, room_id):
        with self._lock:
            self.calls.setdefault(name, [])
            self.metadata[name] = room_id

    def rooms(self):
        with self._lock:
            return [{"name": n, "metadata": self.metadata[n]} for n in list(self.calls)]

    def participants(self, room):
        with self._lock:
            return [dict(p) for p in self.calls.get(room, [])]

    def remove(self, room, identity):
        with self._lock:
            self.removed.append(identity)
            self.calls[room] = [p for p in self.calls[room] if p["identity"] != identity]

    def set_publish(self, room, identity, can_publish):
        with self._lock:
            self.updates.append((identity, can_publish))
            for p in self.calls[room]:
                if p["identity"] == identity:
                    p["permission"] = {"can_publish": can_publish}
                    if not can_publish:
                        p["tracks"] = []  # LiveKit unpublishes what a revoked right published

    def join(self, room_id, identity, *, tracks=(), can_publish=True):
        name = livekit_room(room_id)
        self.create_room(name, room_id)
        with self._lock:
            self.calls[name].append(
                {
                    "identity": identity,
                    "tracks": [{"source": s} for s in tracks],
                    "permission": {"canPublish": can_publish},
                }
            )


@pytest.fixture
def world():
    matrix, livekit = FakeMatrix(), FakeLiveKit()
    return (
        matrix,
        livekit,
        Service(matrix, livekit, "wss://media.acme.kodera.io", AGENT, token_ttl_s=600),
    )


def claims(token):
    return jwt.decode(token, SECRET, algorithms=["HS256"], issuer=KEY)


def test_a_member_gets_a_token_for_that_room_only_as_this_device(world):
    _, livekit, service = world
    grant = service.grant("tok-alice", AUDIO)
    granted = claims(grant.token)
    assert granted["sub"] == f"{ALICE}|DEV1"
    assert granted["video"] == {
        "roomJoin": True,
        "room": livekit_room(AUDIO),
        "canSubscribe": True,
        "canPublish": True,
        "canPublishData": True,
    }
    assert 590 <= granted["exp"] - time.time() <= 600
    assert livekit.metadata[livekit_room(AUDIO)] == AUDIO and grant.listen_only is False


@pytest.mark.parametrize(
    ("token", "room", "status"),
    [
        ("tok-carol", AUDIO, 403),
        ("tok-alice", TEXT, 403),
        ("tok-alice", "!nope:x", 403),
        ("bad", AUDIO, 401),
        ("", AUDIO, 401),
        ("   ", AUDIO, 401),
        ("tok-alice\n", AUDIO, 401),
        ("tok-alice\x7f", AUDIO, 401),
        ("tok-alice", "not-a-room", 400),
        ("tok-alice", None, 400),
    ],
)
def test_who_is_refused(world, token, room, status):
    *_, service = world
    with pytest.raises(RefusedError) as refused:
        service.grant(token, room)
    assert refused.value.status == status


def test_matrix_whoami_never_falls_back_to_the_service_account_token():
    matrix = Matrix("http://synapse:8008", "room-access-token")
    seen: list[str] = []

    def fake_request(url, method, headers, body, timeout, ok):
        seen.append(headers["Authorization"])
        if headers["Authorization"] == "Bearer room-access-token":
            return 200, {"user_id": ROOM_ACCESS, "device_id": "RA"}
        return 401, {}

    with patch("room_access.clients._request", side_effect=fake_request):
        assert matrix.whoami("") is None
        assert seen == ["Bearer "]
        service = Service(matrix, FakeLiveKit(), "wss://media.acme.kodera.io", AGENT)
        for candidate in ("", " ", "   ", "\t", "tok-alice\r\n"):
            with pytest.raises(RefusedError) as refused:
                service.grant(candidate, AUDIO)
            assert refused.value.status == 401

        class _Sock:
            def __init__(self, raw: bytes) -> None:
                self.reader = io.BytesIO(raw)
                self.writer = io.BytesIO()

            def makefile(self, mode: str, *args: Any) -> io.BytesIO:
                return self.reader if "r" in mode else self.writer

            def sendall(self, data: bytes) -> None:
                self.writer.write(data)

            def settimeout(self, value: float | None) -> None:
                return None

        server = make_token_server("127.0.0.1", 0, service, frozenset({CONSOLE}))
        try:
            payload = json.dumps({"room_id": AUDIO}).encode()
            for header in ("Bearer ", "Bearer    ", "Bearer \t"):
                raw = (
                    f"POST /token HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: {header}\r\n"
                    f"Content-Length: {len(payload)}\r\n\r\n"
                ).encode() + payload
                sock = _Sock(raw)
                server.RequestHandlerClass(sock, ("127.0.0.1", 9999), server)
                response = sock.writer.getvalue().decode()
                assert response.startswith("HTTP/1.0 401 ")
                assert '"unauthenticated"' in response
        finally:
            server.server_close()
        assert seen == ["Bearer "]


def test_an_archived_room_admits_no_one(world):
    matrix, _, service = world
    matrix.policy(AUDIO, archived=True)
    with pytest.raises(RefusedError):
        service.grant("tok-alice", AUDIO)


def test_listen_only_withholds_publishing_except_from_the_exempt(world):
    matrix, _, service = world
    matrix.policy(AUDIO, listen_only=True, may_publish=[BOB])
    assert claims(service.grant("tok-alice", AUDIO).token)["video"]["canPublish"] is False
    assert claims(service.grant("tok-bob", AUDIO).token)["video"]["canPublish"] is True


def test_occupancy_groups_devices_shows_sharing_and_is_written_only_on_change(world):
    matrix, livekit, service = world
    livekit.join(AUDIO, f"{ALICE}|DEV1", tracks=["MICROPHONE", "SCREEN_SHARE"])
    livekit.join(AUDIO, f"{ALICE}|DEV2")  # a second tab does not replace the first
    livekit.join(AUDIO, f"{BOB}|B1", tracks=[1])  # LiveKit's numeric CAMERA

    service.reconcile_once()
    service.reconcile_once()

    assert len(matrix.writes) == 1
    assert matrix.writes[0]["participants"] == [
        {"user_id": ALICE, "devices": 2, "screen_share": True, "camera": False},
        {"user_id": BOB, "devices": 1, "screen_share": False, "camera": True},
    ]
    assert matrix.joined_reads == 2  # one read per room per pass


def test_the_guard_removes_a_non_member_on_each_pass_and_never_shows_them(world):
    matrix, livekit, service = world
    livekit.join(AUDIO, f"{ALICE}|DEV1")
    livekit.join(AUDIO, f"{CAROL}|C1")  # a stale or forged grant
    service.reconcile_once()
    assert livekit.removed == [f"{CAROL}|C1"]
    assert [p["user_id"] for p in matrix.writes[-1]["participants"]] == [ALICE]

    matrix.rooms[AUDIO]["joined"].discard(ALICE)  # removed from the channel
    service.reconcile_once()
    assert livekit.removed[-1] == f"{ALICE}|DEV1" and matrix.writes[-1]["participants"] == []


def test_listen_only_switched_during_a_call_updates_publish_rights_once(world):
    matrix, livekit, service = world
    livekit.join(AUDIO, f"{ALICE}|DEV1", tracks=["MICROPHONE"])
    livekit.join(AUDIO, f"{BOB}|B1", tracks=["MICROPHONE"])
    service.reconcile_once()
    assert livekit.updates == []

    matrix.policy(AUDIO, listen_only=True, may_publish=[BOB])
    service.reconcile_once()
    service.reconcile_once()
    assert livekit.updates == [(f"{ALICE}|DEV1", False)]

    matrix.policy(AUDIO, listen_only=False, may_publish=[])
    service.reconcile_once()
    assert livekit.updates[-1] == (f"{ALICE}|DEV1", True)


@pytest.mark.parametrize("change", ["removed", "text", "missing-kind"])
@pytest.mark.parametrize("refresh", ["reconcile", "signed-webhook"])
def test_invalidated_audio_policy_revokes_existing_call_and_future_grants(world, change, refresh):
    matrix, livekit, service = world
    listener = make_token_server("127.0.0.1", 0, service, frozenset({CONSOLE}))
    base = serve(listener)
    request = json.dumps({"room_id": AUDIO}).encode()
    headers = {"Authorization": "Bearer tok-alice", "Origin": CONSOLE}
    webhook = None
    try:
        status, _, answer = post(f"{base}/token", request, headers)
        assert status == 200
        participant = claims(answer["token"])["sub"]
        livekit.join(AUDIO, participant, tracks=["MICROPHONE"])
        service.reconcile_once()
        assert matrix.writes[-1]["participants"][0]["user_id"] == ALICE

        if change == "removed":
            del matrix.rooms[AUDIO]["state"][POLICY]
        elif change == "text":
            matrix.policy(AUDIO, kind="text")
        else:
            del matrix.rooms[AUDIO]["state"][POLICY]["kind"]
        assert post(f"{base}/token", request, headers)[0] == 403
        membership_reads = matrix.joined_reads

        if refresh == "signed-webhook":
            webhook = make_webhook_server("127.0.0.1", 0, livekit, service.on_webhook)
            event = json.dumps(
                {
                    "event": "participant_joined",
                    "room": {"name": livekit_room(AUDIO), "metadata": AUDIO},
                }
            ).encode()
            assert (
                post(f"{serve(webhook)}/livekit/webhook", event, {"Authorization": signed(event)})[
                    0
                ]
                == 200
            )
        else:
            service.reconcile_once()

        assert livekit.removed == [participant], "invalid audio policy retained an active caller"
        assert livekit.calls[livekit_room(AUDIO)] == []
        assert matrix.writes[-1]["participants"] == []
        assert matrix.joined_reads == membership_reads, "invalid policy queried room membership"
    finally:
        if webhook is not None:
            webhook.shutdown()
            webhook.server_close()
        listener.shutdown()
        listener.server_close()


@pytest.mark.parametrize(
    "changes",
    [
        {"version": 2},
        {"version": True},
        {"archived": None},
        {"listen_only": None},
        {"listen_only": "false"},
        {"may_publish": None},
        {"may_publish": ALICE},
        {"may_publish": [ALICE, 1]},
    ],
)
def test_malformed_audio_policy_never_grants_or_retains_a_caller(world, changes):
    matrix, livekit, service = world
    matrix.policy(AUDIO, **changes)
    with pytest.raises(RefusedError) as refusal:
        service.grant("tok-alice", AUDIO)
    assert refusal.value.status == 403
    assert livekit.calls == {}, "malformed policy created a media room before refusing"
    participant = f"{ALICE}|DEV1"
    livekit.join(AUDIO, participant, tracks=["MICROPHONE"])
    service.reconcile_once()
    assert livekit.removed == [participant]
    assert livekit.calls[livekit_room(AUDIO)] == []
    assert matrix.joined_reads == 0


def test_a_room_livekit_closed_shows_nobody(world):
    matrix, livekit, service = world
    livekit.join(AUDIO, f"{ALICE}|DEV1")
    service.reconcile_once()
    del livekit.calls[livekit_room(AUDIO)]
    service.reconcile_once()
    assert matrix.writes[-1]["participants"] == []


def test_a_restart_mid_call_writes_nothing_for_an_unchanged_call(world):
    matrix, livekit, service = world
    livekit.join(AUDIO, f"{ALICE}|DEV1")
    service.reconcile_once()
    restarted = Service(matrix, livekit, "wss://media.acme.kodera.io", AGENT)

    restarted.reconcile_once()

    assert len(matrix.writes) == 1 and livekit.removed == [] and livekit.updates == []
    livekit.join(AUDIO, f"{BOB}|B1")
    restarted.reconcile_once()
    assert [p["user_id"] for p in matrix.writes[-1]["participants"]] == [ALICE, BOB]


def test_new_audio_rooms_are_joined_on_the_next_pass(world):
    matrix, _, service = world
    matrix.invites = ["!new:acme.kodera.io"]
    service.reconcile_once()
    assert matrix.invites == [] and matrix.inviters == [AGENT]


# -- a member's own room (P2-1): their direct message, where they hold every power level ------

DM = "!dm:acme.kodera.io"


def test_a_policy_a_member_wrote_in_their_direct_message_grants_nothing(world):
    matrix, livekit, service = world
    # Alice opens a direct message with room-access's account, which (before) joined any
    # invitation, writes an audio policy there herself, and asks for a token.
    matrix.rooms[DM] = {
        "state": {
            POLICY: {
                "version": 1,
                "kind": "audio",
                "listen_only": False,
                "may_publish": [],
                "archived": False,
            }
        },
        "joined": {ALICE, ROOM_ACCESS},
    }
    matrix.senders[(DM, POLICY)] = ALICE
    listener = make_token_server("127.0.0.1", 0, service, frozenset({CONSOLE}))
    base = serve(listener)
    request = json.dumps({"room_id": DM}).encode()
    try:
        status, _, answer = post(f"{base}/token", request, {"Authorization": "Bearer tok-alice"})
        assert (status, answer) == (403, {})
        assert livekit.calls == {}, "a refused grant created a media room"
        # A call already in that room (a token minted before) is emptied on the next pass.
        livekit.join(DM, f"{ALICE}|DEV1", tracks=["MICROPHONE"])
        service.reconcile_once()
        assert livekit.removed == [f"{ALICE}|DEV1"]
        # The sender is what decides: the same policy from the agent admits her.
        matrix.senders[(DM, POLICY)] = AGENT
        assert post(f"{base}/token", request, {"Authorization": "Bearer tok-alice"})[0] == 200
    finally:
        listener.shutdown()
        listener.server_close()


def test_matrix_reads_the_policy_as_a_whole_event_with_its_sender():
    matrix = Matrix("http://synapse:8008", "room-access-token")
    seen: list[str] = []
    event = {"type": POLICY, "state_key": "", "sender": AGENT, "content": {"version": 1}}

    def fake_request(url, method, headers, body, timeout, ok):
        seen.append(url)
        return 200, event

    with patch("room_access.clients._request", side_effect=fake_request):
        assert matrix.state_event(AUDIO, POLICY) == event
    assert seen == [
        "http://synapse:8008/_matrix/client/v3/rooms/%21audio%3Aacme.kodera.io"
        "/state/io.kodera.room.policy/?format=event"
    ]


def test_room_access_joins_only_the_agents_invitations():
    matrix = Matrix("http://synapse:8008", "room-access-token")
    calls: list[tuple[str, str]] = []

    def invite_from(sender: str, invitee: str = ROOM_ACCESS) -> dict[str, Any]:
        return {
            "invite_state": {
                "events": [
                    {"type": "m.room.create", "state_key": "", "sender": sender, "content": {}},
                    {
                        "type": "m.room.member",
                        "state_key": invitee,
                        "sender": sender,
                        "content": {"membership": "invite"},
                    },
                ]
            }
        }

    rooms = {
        "!audio-new:acme.kodera.io": invite_from(AGENT),
        DM: invite_from(ALICE),
        # Someone else's invitation in the stripped state does not count as this account's.
        "!other:acme.kodera.io": invite_from(AGENT, invitee=BOB),
    }

    def fake_request(url, method, headers, body, timeout, ok):
        path = url.removeprefix("http://synapse:8008")
        if path == "/_matrix/client/v3/account/whoami":
            return 200, {"user_id": ROOM_ACCESS, "device_id": "RA"}
        if path.startswith("/_matrix/client/v3/sync?"):
            return 200, {"next_batch": "s1", "rooms": {"invite": rooms}}
        calls.append((method, path))
        return 200, {}

    with patch("room_access.clients._request", side_effect=fake_request):
        assert matrix.accept_invites(AGENT) == ["!audio-new:acme.kodera.io"]
    assert calls == [
        ("POST", "/_matrix/client/v3/rooms/%21audio-new%3Aacme.kodera.io/join"),
        ("POST", "/_matrix/client/v3/rooms/%21dm%3Aacme.kodera.io/leave"),
    ]


def test_room_access_needs_the_agents_full_matrix_id():
    env = {
        "ROOM_ACCESS_SYNAPSE_URL": "http://synapse:8008",
        "ROOM_ACCESS_MATRIX_TOKEN": "room-access-token",
        "LIVEKIT_URL": "http://livekit:7880",
        "LIVEKIT_WS_URL": "wss://media.acme.kodera.io",
        "LIVEKIT_API_KEY": KEY,
        "LIVEKIT_API_SECRET": SECRET,
        "ROOM_ACCESS_ALLOWED_ORIGINS": CONSOLE,
    }
    with pytest.raises(ConfigError, match="ROOM_ACCESS_AGENT_USER"):
        Config.from_env(env)
    for wrong in ("kodera-agent", "@kodera-agent", "@:acme.kodera.io", "@a b:acme.kodera.io"):
        with pytest.raises(ConfigError, match="ROOM_ACCESS_AGENT_USER"):
            Config.from_env({**env, "ROOM_ACCESS_AGENT_USER": wrong})
    assert Config.from_env({**env, "ROOM_ACCESS_AGENT_USER": AGENT}).agent_user == AGENT


# -- the listeners --------------------------------------------------------------------------


def serve(server):
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{server.server_address[1]}"


def post(url, body: bytes, headers):
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")  # noqa: S310 - the test's own loopback listener
    try:
        with urllib.request.urlopen(request, timeout=5) as response:  # noqa: S310 - the test's own loopback listener
            return response.status, dict(response.headers), json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:
        with exc:
            return exc.code, dict(exc.headers), {}


def test_the_token_listener_answers_cors_only_to_the_console(world):
    *_, service = world
    server = make_token_server("127.0.0.1", 0, service, frozenset({CONSOLE}))
    base = serve(server)
    body = json.dumps({"room_id": AUDIO}).encode()
    try:
        status, headers, answer = post(
            f"{base}/token",
            body,
            {
                "Authorization": "Bearer tok-alice",
                "Origin": CONSOLE,
                "Content-Type": "application/json",
            },
        )
        assert status == 200 and headers["Access-Control-Allow-Origin"] == CONSOLE
        assert (
            claims(answer["token"])["sub"] == f"{ALICE}|DEV1"
            and headers["Cache-Control"] == "no-store"
        )
        status, headers, _ = post(
            f"{base}/token",
            body,
            {"Authorization": "Bearer tok-alice", "Origin": "https://evil.test"},
        )
        assert "Access-Control-Allow-Origin" not in headers
        assert post(f"{base}/token", body, {"Origin": CONSOLE})[0] == 401
        assert (
            post(f"{base}/token", body, {"Authorization": "Bearer ", "Origin": CONSOLE})[0] == 401
        )
        assert (
            post(f"{base}/token", body, {"Authorization": "Bearer    ", "Origin": CONSOLE})[0]
            == 401
        )
        assert (
            post(
                f"{base}/token",
                json.dumps({"room_id": AUDIO, "pad": "x" * 5000}).encode(),
                {"Authorization": "Bearer tok-alice"},
            )[0]
            == 413
        )
        assert post(f"{base}/token", b"{", {"Authorization": "Bearer tok-alice"})[0] == 400
        preflight = urllib.request.Request(  # noqa: S310 - the test's own loopback listener
            f"{base}/token", method="OPTIONS", headers={"Origin": CONSOLE}
        )
        with urllib.request.urlopen(preflight, timeout=5) as response:  # noqa: S310 - the test's own loopback listener
            assert response.status == 204
            assert "Authorization" in response.headers["Access-Control-Allow-Headers"]
    finally:
        server.shutdown()
        server.server_close()


def signed(body: bytes) -> str:
    digest = base64.b64encode(hashlib.sha256(body).digest()).decode()
    return jwt.encode(
        {"iss": KEY, "exp": int(time.time()) + 60, "sha256": digest}, SECRET, algorithm="HS256"
    )


def test_a_signed_participant_joined_runs_the_guard_and_an_unsigned_one_is_refused(world):
    matrix, livekit, service = world
    livekit.join(AUDIO, f"{CAROL}|C1")
    server = make_webhook_server("127.0.0.1", 0, livekit, service.on_webhook)
    base = serve(server)
    event = json.dumps(
        {"event": "participant_joined", "room": {"name": livekit_room(AUDIO), "metadata": AUDIO}}
    ).encode()
    try:
        assert post(f"{base}/livekit/webhook", event, {"Authorization": "Bearer forged"})[0] == 401
        assert livekit.removed == []
        assert post(f"{base}/livekit/webhook", event, {"Authorization": signed(event)})[0] == 200
        assert livekit.removed == [f"{CAROL}|C1"]
        meet = json.dumps({"event": "participant_joined", "room": {"name": "meet-room-1"}}).encode()
        assert post(f"{base}/livekit/webhook", meet, {"Authorization": signed(meet)})[0] == 200
    finally:
        server.shutdown()
        server.server_close()


def _stall(port: int, body: bytes = b'{"room_id": ', length: int = 64) -> socket.socket:
    """A client that sends its headers and part of its body, then goes silent."""
    sock = socket.create_connection(("127.0.0.1", port), timeout=5)
    sock.sendall(
        (
            f"POST /token HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer tok-alice\r\n"
            f"Content-Length: {length}\r\n\r\n"
        ).encode()
        + body
    )
    return sock


def _until_closed(sock: socket.socket) -> bytes:
    answer = b""
    try:
        while chunk := sock.recv(4096):
            answer += chunk
    except ConnectionResetError:
        pass
    return answer


@pytest.mark.parametrize("listener", ["token", "webhook"])
def test_a_slow_body_is_cut_off_and_cannot_exhaust_the_pool(world, listener):
    _, livekit, service = world
    workers, timeout_s = 2, 1.0
    if listener == "token":
        server = make_token_server(
            "127.0.0.1", 0, service, frozenset({CONSOLE}), timeout_s=timeout_s, workers=workers
        )
    else:
        server = make_webhook_server(
            "127.0.0.1", 0, livekit, service.on_webhook, timeout_s=timeout_s, workers=workers
        )
    base, port = serve(server), server.server_address[1]
    stalled: list[socket.socket] = []
    try:
        started = time.monotonic()
        stalled = [_stall(port) for _ in range(workers)]
        time.sleep(0.2)  # both stalled connections hold their slots
        extra = _stall(port)
        stalled.append(extra)
        assert _until_closed(extra) == b"", "a connection past the pool was served"
        assert time.monotonic() - started < timeout_s, "the pool queued instead of refusing"
        for sock in stalled[:workers]:
            assert _until_closed(sock).startswith(b"HTTP/1.0 408 ")
        assert time.monotonic() - started < 3 * timeout_s
        # The slots are free again.
        if listener == "token":
            whole = json.dumps({"room_id": AUDIO}).encode()
            assert post(f"{base}/token", whole, {"Authorization": "Bearer tok-alice"})[0] == 200
        else:
            event = json.dumps({"event": "room_started", "room": {"name": "meet-1"}}).encode()
            assert (
                post(f"{base}/livekit/webhook", event, {"Authorization": signed(event)})[0] == 200
            )
    finally:
        for sock in stalled:
            sock.close()
        server.shutdown()
        server.server_close()


@pytest.mark.parametrize("listener", ["token", "webhook"])
def test_a_connection_silent_before_its_headers_end_is_cut_off(world, listener):
    _, livekit, service = world
    if listener == "token":
        server = make_token_server("127.0.0.1", 0, service, frozenset({CONSOLE}), timeout_s=1.0)
    else:
        server = make_webhook_server("127.0.0.1", 0, livekit, service.on_webhook, timeout_s=1.0)
    serve(server)
    sock = socket.create_connection(("127.0.0.1", server.server_address[1]), timeout=5)
    try:
        started = time.monotonic()
        sock.sendall(b"POST /token HTTP/1.1\r\nHost: 127.0.0.1\r\n")
        assert _until_closed(sock) == b""
        assert time.monotonic() - started < 2.0
    finally:
        sock.close()
        server.shutdown()
        server.server_close()


@pytest.mark.parametrize("listener", ["token", "webhook"])
def test_trickled_headers_are_cut_off_at_the_header_deadline(world, listener):
    _, livekit, service = world
    if listener == "token":
        server = make_token_server(
            "127.0.0.1", 0, service, frozenset({CONSOLE}), timeout_s=1.0, workers=2
        )
    else:
        server = make_webhook_server(
            "127.0.0.1", 0, livekit, service.on_webhook, timeout_s=1.0, workers=2
        )
    serve(server)
    sock = socket.create_connection(("127.0.0.1", server.server_address[1]), timeout=5)
    stop = threading.Event()

    def trickle_headers() -> None:
        try:
            sock.sendall(b"POST /token HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Pad: ")
            while not stop.wait(0.25):
                sock.sendall(b"a")
        except OSError:
            return

    sender = threading.Thread(target=trickle_headers, daemon=True)
    started = time.monotonic()
    sender.start()
    try:
        assert _until_closed(sock) == b""
        assert time.monotonic() - started < 2.0
    finally:
        stop.set()
        sock.close()
        sender.join(timeout=2)
        server.shutdown()
        server.server_close()


def test_excessive_header_lines_are_cut_off_before_handler(world):
    *_, service = world
    server = make_token_server("127.0.0.1", 0, service, frozenset({CONSOLE}), timeout_s=2.0)
    serve(server)
    sock = socket.create_connection(("127.0.0.1", server.server_address[1]), timeout=5)
    try:
        many_headers = "".join(f"X-Extra-{i}: v\r\n" for i in range(40)).encode()
        sock.sendall(b"POST /token HTTP/1.1\r\nHost: 127.0.0.1\r\n" + many_headers + b"\r\n")
        assert _until_closed(sock) == b""
    finally:
        sock.close()
        server.shutdown()
        server.server_close()


def test_a_trickled_body_is_cut_off_at_the_read_deadline(world):
    *_, service = world
    server = make_token_server(
        "127.0.0.1", 0, service, frozenset({CONSOLE}), timeout_s=1.0, workers=2
    )
    serve(server)
    sock = _stall(server.server_address[1], body=b"{")
    stop = threading.Event()

    def trickle() -> None:
        # One byte every 0.3 s: never silent for the socket timeout, never a whole body.
        while not stop.wait(0.3):
            try:
                sock.sendall(b" ")
            except OSError:
                return

    sender = threading.Thread(target=trickle, daemon=True)
    started = time.monotonic()
    sender.start()
    try:
        assert _until_closed(sock).startswith(b"HTTP/1.0 408 ")
        assert time.monotonic() - started < 2.0
    finally:
        stop.set()
        sock.close()
        sender.join(timeout=2)
        server.shutdown()
        server.server_close()


def test_room_access_and_the_agent_name_livekit_rooms_alike():
    for room_id in (AUDIO, TEXT, "!x:y"):
        assert livekit_room(room_id) == agent_livekit_room(room_id)
    assert OCCUPANCY == "io.kodera.room.occupancy"


def test_concurrent_webhook_refreshes_and_reconcile_passes_never_race(world):
    matrix, livekit, service = world
    rooms = [f"!audio-{i}:acme.kodera.io" for i in range(8)]
    for idx, room_id in enumerate(rooms):
        matrix.rooms[room_id] = {
            "state": {
                POLICY: {
                    "version": 1,
                    "kind": "audio",
                    "listen_only": idx % 2 == 0,
                    "may_publish": [BOB],
                    "archived": False,
                }
            },
            "joined": {ALICE, BOB},
        }
        livekit.join(room_id, f"{ALICE}|DEV{idx}")
        livekit.join(room_id, f"{BOB}|B{idx}")

    errors: list[BaseException] = []
    barrier = threading.Barrier(len(rooms) + 1)

    def refresh_worker(idx: int, room_id: str) -> None:
        name = livekit_room(room_id)
        try:
            barrier.wait(timeout=5)
            for step in range(40):
                matrix.policy(room_id, listen_only=(step + idx) % 2 == 0)
                service.refresh(name, room_id)
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    def reconcile_worker() -> None:
        try:
            barrier.wait(timeout=5)
            for _ in range(25):
                service.reconcile_once()
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [
        *(threading.Thread(target=refresh_worker, args=(i, r)) for i, r in enumerate(rooms)),
        threading.Thread(target=reconcile_worker),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)
    assert errors == []
    assert service.stats.passes == 25


def test_upstream_refuses_redirects_closes_error_streams_and_catches_http_exceptions():
    # 1. _NoRedirect refuses 302 redirects without following Location.
    handler = clients._NoRedirect()
    req = urllib.request.Request("http://synapse:8008/_matrix/client/v3/account/whoami")
    assert (
        handler.redirect_request(req, None, 302, "Found", Message(), "http://evil.test/steal")
        is None
    )

    # 2. HTTPError responses close their underlying stream both when allowed in `ok` and when raised.
    closed: list[int] = []

    class TrackingHTTPError(urllib.error.HTTPError):
        def close(self) -> None:
            closed.append(self.code)
            super().close()

    def raise_http(code: int):
        def _open(request, timeout=None):
            raise TrackingHTTPError(
                request.full_url,
                code,
                "status",
                Message(),
                io.BytesIO(b'{"errcode":"M_FORBIDDEN"}'),
            )

        return _open

    with patch.object(clients._OPENER, "open", side_effect=raise_http(401)):
        status, payload = clients._request(
            "http://synapse:8008/_matrix/client/v3/account/whoami",
            "GET",
            {"Authorization": "Bearer tok"},
            None,
            5.0,
            (200, 401),
        )
        assert (status, payload) == (401, {})
        assert closed == [401]

    with (
        patch.object(clients._OPENER, "open", side_effect=raise_http(302)),
        pytest.raises(UpstreamError, match="answered 302"),
    ):
        clients._request(
            "http://synapse:8008/_matrix/client/v3/account/whoami",
            "GET",
            {"Authorization": "Bearer tok"},
            None,
            5.0,
            (200,),
        )
    assert closed == [401, 302]

    # 3. Malformed upstream HTTP responses (http.client.HTTPException) become UpstreamError.
    with (
        patch.object(clients._OPENER, "open", side_effect=http.client.BadStatusLine("garbage\r\n")),
        pytest.raises(UpstreamError, match="GET:"),
    ):
        clients._request(
            "http://synapse:8008/_matrix/client/v3/account/whoami",
            "GET",
            {"Authorization": "Bearer tok"},
            None,
            5.0,
            (200,),
        )


@pytest.mark.parametrize("audience,members", [("listed", [BOB]), ("listed", "*"), ("unknown", [])])
def test_private_audio_policy_refuses_even_an_accidentally_joined_nonmember(
    world, audience, members
):
    matrix, livekit, service = world
    matrix.policy(AUDIO, audience=audience, members=members)
    with pytest.raises(RefusedError) as caught:
        service.grant("tok-alice", AUDIO)
    assert caught.value.status == 403, "private audio membership must be explicitly authorized"
    assert livekit.calls == {}
    livekit.join(AUDIO, f"{ALICE}|DEV1", tracks=["MICROPHONE"])
    service.refresh(livekit_room(AUDIO), AUDIO)
    assert livekit.removed == [f"{ALICE}|DEV1"], (
        "private audio policy must evict unauthorized callers"
    )


def test_private_audio_refusal_guard_detects_its_own_omission(world, monkeypatch):
    from room_access import service as module

    check = test_private_audio_policy_refuses_even_an_accidentally_joined_nonmember
    check(world, "listed", [BOB])
    monkeypatch.setattr(module, "_audience_allows", lambda policy, user, agent: True)
    with pytest.raises(pytest.fail.Exception, match="DID NOT RAISE"):
        check(world, "listed", [BOB])
