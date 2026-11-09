"""The tenant agent's Synapse engine (ADR-0018, agent-api 0.5.0 `engine_set_channel_members`), with
the homeserver replaced by an in-memory fake that answers the real request paths the engine sends.
"""

import http.client
import http.server
import logging
import os
import re
import threading
import urllib.error
import urllib.parse
from typing import Any

import pytest
from test_tenant_agent import ALICE, BOB, CAROL, FakeLiveKit, FakeRunner, member_set

from tenant_agent.channels import CHANNEL_KIND, Channels
from tenant_agent.engines import Docs, EngineError, LiveKit, LiveKitUnavailableError, Meet
from tenant_agent.guard import RosterGuard
from tenant_agent.handlers import MEMBER_KIND, Handlers
from tenant_agent.state import MemberSet, State
from tenant_agent.synapse import POLICY, Synapse, SynapseUnavailableError, livekit_room

SERVER = "acme.kodera.io"
AGENT = f"@kodera-agent:{SERVER}"
ROOMS = f"@kodera-rooms:{SERVER}"
TEXT, AUDIO = "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"


def mx(subject: str) -> str:
    return f"@{subject}:{SERVER}"


class FakeHomeserver(Synapse):
    """Synapse's client-server and admin endpoints the engine uses, in memory."""

    def __init__(self, users: tuple[str, ...] = (ALICE, BOB, CAROL)) -> None:
        super().__init__("http://synapse:8008", "agent-token", SERVER, ROOMS)
        self.rooms: dict[str, dict[str, Any]] = {}
        self.aliases: dict[str, str] = {}
        self.accounts = {mx(s): False for s in users}  # user → deactivated
        self.notices: list[tuple[str, str, str]] = []
        self.calls = 0
        self.broken: set[str] = set()  # room ids whose every call fails
        self.erased: list[tuple[str, bool]] = []
        self.unerasable: set[str] = set()  # accounts whose erasure fails
        self.creators: dict[str, str] = {}  # room id → creator, when not the agent
        self.writes: list[str] = []  # every call that is not a GET
        self.reads: list[str] = []  # every GET
        self.providers = [{"id": "oidc-keycloak", "name": "Kodera"}]  # the login flow's
        self.external_ids: dict[str, list[dict[str, str]]] = {}  # accounts made by the agent

    def _call(self, method, path, body=None, *, ok=(200,)):
        self.calls += 1
        (self.writes if method != "GET" else self.reads).append(f"{method} {path}")
        path, _, query = path.partition("?")
        parts = [urllib.parse.unquote(p) for p in path.split("/")]
        route = "/".join(parts)
        room = next((p for p in parts if p.startswith("!")), None)
        if room in self.broken:
            raise EngineError("synapse answered 500")

        def answer(status, value=None):
            if status != 200 and status not in ok:
                raise EngineError(f"synapse answered {status}")
            return status, value or {}

        if "/admin/v1/rooms/" in route:
            return answer(200, {"room_id": room, "creator": self.creators.get(room, AGENT)})
        if route.endswith("/account/whoami"):
            return answer(200, {"user_id": AGENT})
        if route.endswith("/client/v3/login"):
            sso = {"type": "m.login.sso", "identity_providers": self.providers}
            return answer(200, {"flows": [{"type": "m.login.token"}, sso]})
        if "/directory/room/" in route:
            alias = parts[-1]
            return (
                answer(200, {"room_id": self.aliases[alias]})
                if alias in self.aliases
                else answer(404)
            )
        if route.endswith("/createRoom"):
            assert body["room_version"] == "12"
            assert AGENT not in body["power_level_content_override"]["users"]
            room_id = f"!r{len(self.rooms)}:{SERVER}"
            state = {(e["type"], e["state_key"]): e["content"] for e in body["initial_state"]}
            state[("m.room.name", "")] = {"name": body["name"]}
            state[("m.room.topic", "")] = {"topic": body["topic"]}
            state[("m.room.power_levels", "")] = body["power_level_content_override"]
            self.rooms[room_id] = {"state": state, "members": {AGENT: "join"}}
            self.aliases[f"#{body['room_alias_name']}:{SERVER}"] = room_id
            return answer(200, {"room_id": room_id})
        if "/state/" in route:
            key = (parts[parts.index("state") + 1], "")
            if method == "GET":
                found = self.rooms[room]["state"].get(key)
                return answer(200, dict(found)) if found is not None else answer(404)
            if key[0] == "m.room.power_levels":
                assert AGENT not in body["users"]  # Synapse refuses naming the creator (room v12)
            self.rooms[room]["state"][key] = body
            return answer(200, {"event_id": "$e"})
        if route.endswith("/members"):
            chunk = [
                {"type": "m.room.member", "state_key": u, "content": {"membership": m}}
                for u, m in self.rooms[room]["members"].items()
            ]
            return answer(200, {"chunk": chunk})
        if "/admin/v1/join/" in route:
            user = body["user_id"]
            # As Synapse's: a missing account is refused, a deactivated one is joined all the same.
            if user not in self.accounts:
                return answer(404)
            self.rooms[room]["members"][user] = "join"
            return answer(200, {"room_id": room})
        if route.endswith("/invite"):
            self.rooms[room]["members"][body["user_id"]] = "invite"
            return answer(200)
        if route.endswith("/kick"):
            self.rooms[room]["members"][body["user_id"]] = "leave"
            return answer(200)
        if "/send/m.room.message/" in route:
            txn = parts[-1]
            if not any(n[1] == txn for n in self.notices):  # Synapse deduplicates by transaction id
                self.notices.append((room, txn, body["body"]))
            return answer(200, {"event_id": "$n"})
        if "/admin/v1/deactivate/" in route:
            user = parts[-1]
            if user not in self.accounts:
                return answer(404)
            if user in self.unerasable:
                raise EngineError("synapse answered 500")
            self.accounts[user] = True
            self.erased.append((user, body["erase"]))
            return answer(200, {"id_server_unbind_result": "success"})
        if "/admin/v2/users" in route and route.endswith("/users"):
            active = sorted(u for u, gone in self.accounts.items() if not gone)
            return answer(200, {"users": [{"name": u} for u in active]})
        if "/admin/v2/users/" in route:
            user = parts[-1]
            if user not in self.accounts and method == "PUT" and set(body) == {"external_ids"}:
                self.accounts[user] = False  # created, as Synapse's PUT creates a missing user
                self.external_ids[user] = body["external_ids"]
                return answer(201, {"name": user, "deactivated": False})
            if user not in self.accounts:
                return answer(404)
            if method == "PUT":
                self.accounts[user] = body.get("deactivated", self.accounts[user])
                if "external_ids" in body:
                    self.external_ids[user] = body["external_ids"]
                if body.get("deactivated"):
                    for r in self.rooms.values():
                        if r["members"].get(user) == "join":
                            r["members"][user] = "leave"
            return answer(200, {"name": user, "deactivated": self.accounts[user]})
        raise AssertionError(f"unexpected {method} {route}")

    def room_of(self, channel_id: str) -> dict[str, Any]:
        return self.rooms[self.aliases[f"#kodera-ch-{channel_id}:{SERVER}"]]

    def joined(self, channel_id: str) -> set[str]:
        return {u for u, m in self.room_of(channel_id)["members"].items() if m == "join"}


class CallLiveKit(FakeLiveKit):
    def participants(self, room):
        return [{"identity": i} for i in self.rooms_.get(room, [])]


def channel(channel_id=TEXT, **overrides):
    entry = {
        "channel_id": channel_id,
        "kind": "text",
        "name": "general",
        "topic": "",
        "access_etag": '"a1"',
        "archived": False,
        "audience": "listed",
        "members": [ALICE, BOB],
        "denied": [],
        "read_only": False,
        "listen_only": False,
        "exempt": [],
        "notices": [],
    }
    entry.update(overrides)
    return entry


def channel_set(revision, *channels, all_members=(ALICE, BOB, CAROL)):
    return {"revision": revision, "all_members": sorted(all_members), "channels": list(channels)}


def build(tmp_path, homeserver=None, livekit=None, active=(ALICE, BOB, CAROL)):
    """The agent's handlers, with a member set in force (revision 0) holding `active` active:
    only a member it holds active is ever joined. None stores no member set."""
    homeserver = homeserver or FakeHomeserver()
    livekit = livekit or CallLiveKit({})
    state = State(tmp_path)
    if active is not None:
        state.keep(MemberSet(0, frozenset(active), frozenset(), frozenset()))
    runner = FakeRunner()
    meet = Meet(runner, "meet-backend")
    guard = RosterGuard(livekit, meet, state, homeserver)
    channels = Channels(homeserver, livekit, state)
    handlers = Handlers(Docs(runner, "docs-backend"), meet, guard, state, homeserver, channels)
    return handlers, homeserver, livekit, state


def test_the_agent_takes_channel_sets_only_when_the_vm_runs_synapse(tmp_path):
    handlers, *_ = build(tmp_path)
    assert handlers.kinds == (MEMBER_KIND, CHANNEL_KIND)
    without = Handlers(None, None, None, State(tmp_path / "x"))
    assert without.kinds == (MEMBER_KIND,)
    assert without.handle(CHANNEL_KIND, channel_set(1)).error_code == "unsupported_kind"


def test_a_channel_s_room_is_made_under_its_alias_with_its_policy_and_members(tmp_path):
    handlers, homeserver, _, _ = build(tmp_path)

    outcome = handlers.handle(CHANNEL_KIND, channel_set(1, channel(topic="hello")))

    assert outcome.status == "succeeded"
    assert outcome.artefacts == {"revision_applied": 1, "channels_applied": 1, "notices_posted": 0}
    room = homeserver.room_of(TEXT)
    assert homeserver.joined(TEXT) == {AGENT, mx(ALICE), mx(BOB)}
    assert room["state"][(POLICY, "")] == {
        "version": 1,
        "kind": "text",
        "listen_only": False,
        "may_publish": [],
        "archived": False,
    }
    levels = room["state"][("m.room.power_levels", "")]
    assert (
        levels["users"] == {} and levels["events_default"] == 0
    )  # room v12: the creator is implicit
    assert levels["state_default"] == levels["invite"] == levels["kick"] == 100
    assert room["state"][("m.room.topic", "")] == {"topic": "hello"}


def test_applying_the_same_set_twice_changes_nothing(tmp_path):
    handlers, homeserver, _, _ = build(tmp_path)
    channels = (channel(read_only=True, exempt=[ALICE]), channel(AUDIO, kind="audio"))
    handlers.handle(CHANNEL_KIND, channel_set(1, *channels))
    before = {k: dict(v) for k, v in homeserver.room_of(TEXT)["state"].items()}
    homeserver.writes.clear()

    handlers.handle(CHANNEL_KIND, channel_set(1, *channels))
    handlers.reapply()

    # Written only when different: nothing is sent but reads.
    assert homeserver.writes == []
    assert homeserver.room_of(TEXT)["state"] == before
    assert len(homeserver.rooms) == 2


def test_a_member_removed_from_an_audio_room_leaves_the_room_and_its_call(tmp_path):
    homeserver = FakeHomeserver()
    livekit = CallLiveKit({})
    handlers, *_ = build(tmp_path, homeserver, livekit)
    handlers.handle(CHANNEL_KIND, channel_set(1, channel(AUDIO, kind="audio")))
    room_id = homeserver.aliases[f"#kodera-ch-{AUDIO}:{SERVER}"]
    call = livekit_room(room_id)
    livekit.rooms_[call] = [f"{mx(ALICE)}|DEV1", f"{mx(BOB)}|DEV1", f"{mx(BOB)}|DEV2"]

    handlers.handle(CHANNEL_KIND, channel_set(2, channel(AUDIO, kind="audio", members=[ALICE])))

    assert homeserver.joined(AUDIO) == {AGENT, mx(ALICE)}
    assert homeserver.room_of(AUDIO)["members"][ROOMS] == "invite"
    assert sorted(livekit.removed) == [(call, f"{mx(BOB)}|DEV1"), (call, f"{mx(BOB)}|DEV2")]


def test_room_access_is_joined_to_a_new_audio_room_at_once(tmp_path):
    # Invited only, room-access would refuse every token for the room until its next pass
    # accepted the invite (up to its 2 s reconciliation): a member opening a new audio room
    # would be refused. Its account exists from the tenant's bootstrap, so it is joined.
    homeserver = FakeHomeserver()
    homeserver.accounts[ROOMS] = False
    handlers, *_ = build(tmp_path, homeserver)
    handlers.handle(CHANNEL_KIND, channel_set(1, channel(AUDIO, kind="audio"), channel(TEXT)))

    assert homeserver.room_of(AUDIO)["members"][ROOMS] == "join"
    assert ROOMS not in homeserver.room_of(TEXT)["members"]
    # Applying again neither joins nor invites it again: it is already present.
    homeserver.writes.clear()
    handlers.handle(CHANNEL_KIND, channel_set(2, channel(AUDIO, kind="audio"), channel(TEXT)))
    assert homeserver.room_of(AUDIO)["members"][ROOMS] == "join"
    assert not [w for w in homeserver.writes if "/admin/v1/join/" in w or w.endswith("/invite")]


def test_room_access_is_invited_when_its_account_does_not_exist_yet(tmp_path):
    # The admin join answers 404 for an unknown account; the invite is then the fallback, and the
    # service accepts it on its first pass once it signs in.
    homeserver = FakeHomeserver()
    assert ROOMS not in homeserver.accounts
    handlers, *_ = build(tmp_path, homeserver)
    handlers.handle(CHANNEL_KIND, channel_set(1, channel(AUDIO, kind="audio")))

    assert homeserver.room_of(AUDIO)["members"][ROOMS] == "invite"


def test_read_only_lets_the_exempt_post_and_listen_only_names_who_may_publish(tmp_path):
    handlers, homeserver, _, _ = build(tmp_path)
    handlers.handle(
        CHANNEL_KIND,
        channel_set(
            1,
            channel(read_only=True, exempt=[ALICE]),
            channel(AUDIO, kind="audio", listen_only=True, exempt=[BOB]),
        ),
    )
    text = homeserver.room_of(TEXT)["state"][("m.room.power_levels", "")]
    assert text["events_default"] == 20 and text["users"][mx(ALICE)] == 20  # §12
    assert text["events"]["m.reaction"] == 0 and text["events"]["m.room.redaction"] == 0
    # Redacting others is moderation (50); inviting and kicking stay the agent's alone (100).
    assert text["redact"] == 50 and text["invite"] == text["kick"] == text["ban"] == 100
    audio = homeserver.room_of(AUDIO)["state"]
    assert audio[(POLICY, "")]["may_publish"] == [mx(BOB)]
    assert audio[("m.room.power_levels", "")]["users"][ROOMS] == 10


def test_a_member_without_an_account_is_joined_on_the_first_application(tmp_path):
    """The account is made before the member's first sign-in, bound to their realm subject as it
    is (not the lowercased localpart), so that sign-in lands on it rather than on a second one."""
    homeserver = FakeHomeserver(users=(ALICE,))
    mixed = "Sub-Dana"
    handlers, *_ = build(tmp_path, homeserver, active=(ALICE, BOB, mixed))
    outcome = handlers.handle(
        CHANNEL_KIND,
        channel_set(1, channel(members=[ALICE, BOB, mixed]), all_members=(ALICE, BOB, mixed)),
    )
    assert outcome.status == "succeeded"
    assert homeserver.joined(TEXT) == {AGENT, mx(ALICE), mx(BOB), mx("sub-dana")}
    assert homeserver.external_ids == {
        mx(BOB): [{"auth_provider": "oidc-keycloak", "external_id": BOB}],
        mx("sub-dana"): [{"auth_provider": "oidc-keycloak", "external_id": mixed}],
    }
    assert not any(w.startswith("PUT") and ALICE in w for w in homeserver.writes)


def test_no_account_is_made_for_an_inactive_or_erased_member(tmp_path):
    """Revocation wins over a set that still names the member: the member set's inactive and
    erased subjects, and the erasure ledger's accounts, never get one."""
    homeserver = FakeHomeserver(users=(ALICE,))
    handlers, _, _, state = build(tmp_path, homeserver)
    dave = "sub-dave"
    state.keep(
        MemberSet(1, frozenset({ALICE}), frozenset({BOB, CAROL}), frozenset(), frozenset({CAROL}))
    )
    state.record_erased(mx(dave))
    everyone = (ALICE, BOB, CAROL, dave)
    outcome = handlers.handle(
        CHANNEL_KIND,
        channel_set(1, channel(members=list(everyone)), all_members=everyone),
    )
    assert outcome.status == "succeeded"
    assert homeserver.joined(TEXT) == {AGENT, mx(ALICE)}
    assert homeserver.external_ids == {}


def test_no_member_is_joined_or_given_an_account_while_no_member_set_is_stored(tmp_path):
    """The channel set alone is no proof a member is still one: until a member set is in force,
    the agent joins nobody and makes no account, and nobody waits."""
    homeserver = FakeHomeserver(users=(ALICE,))
    handlers, *_ = build(tmp_path, homeserver, active=None)
    outcome = handlers.handle(CHANNEL_KIND, channel_set(1, channel()))
    assert outcome.status == "succeeded" and homeserver.joined(TEXT) == {AGENT}
    assert homeserver.external_ids == {} and not handlers.waiting


def test_a_released_member_is_neither_joined_nor_given_an_account(tmp_path):
    """Released (no longer a member, not revoked) is not active: only an active member is let in."""
    homeserver = FakeHomeserver(users=(ALICE, BOB))
    handlers, _, _, state = build(tmp_path, homeserver)
    state.keep(MemberSet(1, frozenset({ALICE}), frozenset(), frozenset({BOB, CAROL})))
    everyone = (ALICE, BOB, CAROL)
    outcome = handlers.handle(
        CHANNEL_KIND, channel_set(1, channel(members=list(everyone)), all_members=everyone)
    )
    assert outcome.status == "succeeded" and homeserver.joined(TEXT) == {AGENT, mx(ALICE)}
    assert homeserver.external_ids == {} and not handlers.waiting


def test_an_erased_account_is_not_joined_even_when_a_stale_member_set_holds_it_active(tmp_path):
    """The erasure ledger outlives any member set: an erased account is never let back in."""
    homeserver = FakeHomeserver(users=(ALICE, BOB))
    handlers, _, _, state = build(tmp_path, homeserver)
    state.record_erased(mx(BOB))
    outcome = handlers.handle(CHANNEL_KIND, channel_set(1, channel()))
    assert outcome.status == "succeeded" and homeserver.joined(TEXT) == {AGENT, mx(ALICE)}


def test_a_deactivated_account_is_neither_touched_nor_joined(tmp_path, caplog):
    """Synapse's admin join joins a deactivated account too, so the account is read first: it is
    not re-made, reactivated, rebound or joined, and the skip is logged."""
    homeserver = FakeHomeserver(users=(ALICE, BOB))
    homeserver.accounts[mx(BOB)] = True  # deactivated, by an earlier member set
    handlers, *_ = build(tmp_path, homeserver)
    with caplog.at_level(logging.WARNING, logger="tenant_agent.channels"):
        outcome = handlers.handle(CHANNEL_KIND, channel_set(1, channel()))
    assert f"not joining {mx(BOB)}: the account is deactivated" in caplog.messages
    assert outcome.status == "succeeded" and homeserver.joined(TEXT) == {AGENT, mx(ALICE)}
    assert homeserver.accounts[mx(BOB)] is True and homeserver.external_ids == {}
    assert not any(w.startswith("PUT") and "/admin/v2/users/" in w for w in homeserver.writes)


def test_a_member_held_inactive_is_not_joined_even_with_an_active_account(tmp_path):
    """The member set wins over a channel set that still names the member, before the account's
    deactivation has landed."""
    homeserver = FakeHomeserver(users=(ALICE, BOB))
    handlers, _, _, state = build(tmp_path, homeserver)
    state.keep(MemberSet(1, frozenset({ALICE}), frozenset({BOB}), frozenset()))
    outcome = handlers.handle(CHANNEL_KIND, channel_set(1, channel()))
    assert outcome.status == "succeeded" and homeserver.joined(TEXT) == {AGENT, mx(ALICE)}


@pytest.mark.parametrize(
    "providers",
    [[], [{"id": "oidc-keycloak", "name": "Kodera"}, {"id": "oidc-other", "name": "Other"}]],
    ids=["none", "two"],
)
def test_no_account_is_made_without_exactly_one_sign_in_provider(tmp_path, providers):
    """Bound to a guessed provider, the account would not be the one the member signs in to."""
    homeserver = FakeHomeserver(users=(ALICE,))
    homeserver.providers = providers
    handlers, *_ = build(tmp_path, homeserver)
    outcome = handlers.handle(CHANNEL_KIND, channel_set(1, channel()))
    assert outcome.status == "succeeded" and homeserver.joined(TEXT) == {AGENT, mx(ALICE)}
    assert homeserver.external_ids == {}


@pytest.mark.parametrize("revoked", ["deactivated", "inactive"])
def test_a_member_not_joined_because_revoked_does_not_wait(tmp_path, revoked):
    """Only a member with no account waits: one held inactive or deactivated would keep the
    30 s account read going for nothing."""
    homeserver = FakeHomeserver(users=(ALICE, BOB))
    handlers, _, _, state = build(tmp_path, homeserver)
    if revoked == "deactivated":
        homeserver.accounts[mx(BOB)] = True
    else:  # held inactive by the member set, its account not yet deactivated
        state.keep(MemberSet(1, frozenset({ALICE}), frozenset({BOB}), frozenset()))
    assert handlers.handle(CHANNEL_KIND, channel_set(1, channel())).status == "succeeded"
    assert homeserver.joined(TEXT) == {AGENT, mx(ALICE)} and not handlers.waiting


def test_a_member_who_signs_in_is_joined_at_the_next_check_not_the_re_application(tmp_path):
    homeserver = FakeHomeserver(users=(ALICE,))
    homeserver.providers = []  # no account can be made ahead: Bob waits for his first sign-in
    handlers, *_ = build(tmp_path, homeserver)
    assert handlers.handle(CHANNEL_KIND, channel_set(1, channel())).status == "succeeded"
    assert handlers.waiting and homeserver.joined(TEXT) == {AGENT, mx(ALICE)}

    # Bob has not signed in yet: the check reads the accounts and writes nothing.
    writes = list(homeserver.writes)
    assert handlers.join_waiting() is False
    assert homeserver.writes == writes

    homeserver.accounts[mx(BOB)] = False  # Bob opens Espace: his first sign-in makes the account
    assert handlers.join_waiting() is True
    assert homeserver.joined(TEXT) == {AGENT, mx(ALICE), mx(BOB)}

    # No one waits any more: the check costs no call at all.
    calls = homeserver.calls
    assert not handlers.waiting and handlers.join_waiting() is False
    assert homeserver.calls == calls


def test_a_new_member_reads_their_channels_within_a_minute_of_first_opening_espace(tmp_path):
    """On the loop's own schedule, with Core's longest poll hint (300 s), and Bob signing in just
    after a check: the worst case."""
    from tenant_agent.__main__ import Periodic
    from tenant_agent.agent import Agent

    class Sweep:
        def enforce(self):
            pass

    homeserver = FakeHomeserver(users=(ALICE,))
    homeserver.providers = []  # no account can be made ahead: Bob waits for his first sign-in
    handlers, _, _, state = build(tmp_path, homeserver)
    assert handlers.handle(CHANNEL_KIND, channel_set(1, channel())).status == "succeeded"
    periodic = Periodic(Agent(None, handlers, state), Sweep(), 0.0)
    now, signed_in_at, ticks = 0.0, None, 0
    periodic.run(now)  # the start-up re-application
    while mx(BOB) not in homeserver.joined(TEXT):
        ticks += 1
        assert ticks < 100
        now += periodic.sleep_s(300)
        periodic.run(now)
        if signed_in_at is None:
            homeserver.accounts[mx(BOB)] = False
            signed_in_at = now
    assert now - signed_in_at <= 60


def _account_reads(homeserver):
    return sum(1 for read in homeserver.reads if "/_synapse/admin/v2/users?" in read)


@pytest.mark.parametrize("synapse_fails", [False, True])
def test_the_join_check_reads_the_accounts_once_per_period_whatever_the_poll_hint(
    tmp_path, synapse_fails
):
    """Core may hint a 3 s poll: the account read still happens once per JOIN_RETRY_S while Bob
    waits, and a homeserver that fails the read is not asked again before the next period."""
    from tenant_agent.__main__ import JOIN_RETRY_S, Periodic
    from tenant_agent.agent import Agent

    class Sweep:
        def enforce(self):
            pass

    homeserver = FakeHomeserver(users=(ALICE,))
    homeserver.providers = []  # no account can be made ahead: Bob waits for his first sign-in
    handlers, _, _, state = build(tmp_path, homeserver)
    assert handlers.handle(CHANNEL_KIND, channel_set(1, channel())).status == "succeeded"
    periodic = Periodic(Agent(None, handlers, state), Sweep(), 0.0)
    periodic.run(0.0)  # the start-up re-application
    assert handlers.waiting
    if synapse_fails:
        failed = []

        def active_users():
            failed.append(1)
            raise SynapseUnavailableError("synapse: timed out")

        homeserver.active_users = active_users
    before, now, span = _account_reads(homeserver), 0.0, 4 * JOIN_RETRY_S
    while now < span:
        now += periodic.sleep_s(3)
        periodic.run(now)
    reads = len(failed) if synapse_fails else _account_reads(homeserver) - before
    assert 1 <= reads <= span // JOIN_RETRY_S, f"{reads} account reads in {span} s"


def test_a_pass_that_stops_early_keeps_whoever_was_waiting(tmp_path):
    class Flaky(FakeHomeserver):
        unreachable = False

        def _call(self, method, path, body=None, *, ok=(200,)):
            if self.unreachable:
                raise SynapseUnavailableError("synapse: timed out")
            return super()._call(method, path, body, ok=ok)

    homeserver = Flaky(users=(ALICE,))
    homeserver.providers = []  # no account can be made ahead: Bob waits for his first sign-in
    handlers, *_ = build(tmp_path, homeserver)
    assert handlers.handle(CHANNEL_KIND, channel_set(1, channel())).status == "succeeded"
    assert mx(BOB) in handlers._channels.waiting

    homeserver.unreachable = True  # the next application stops at its first call
    assert handlers.handle(CHANNEL_KIND, channel_set(2, channel())).status == "failed"
    assert mx(BOB) in handlers._channels.waiting, (
        "a pass that reached no channel forgot who was waiting"
    )

    homeserver.unreachable = False
    homeserver.accounts[mx(BOB)] = False  # Bob signs in
    assert handlers.join_waiting() is True
    assert mx(BOB) in homeserver.joined(TEXT)


def test_a_notice_is_posted_once_whatever_the_redeliveries(tmp_path):
    handlers, homeserver, _, _ = build(tmp_path)
    notice = {
        "notice_id": "33333333-3333-4333-8333-333333333333",
        "body": "Ada joined as an administrator",
    }
    first = handlers.handle(CHANNEL_KIND, channel_set(1, channel(notices=[notice])))
    again = handlers.handle(CHANNEL_KIND, channel_set(1, channel(notices=[notice])))
    handlers.reapply()
    assert first.artefacts["notices_posted"] == 1 and again.artefacts["notices_posted"] == 0
    assert [n[2] for n in homeserver.notices] == ["Ada joined as an administrator"]


def test_one_channel_that_fails_is_named_and_the_others_are_applied(tmp_path):
    handlers, homeserver, _, _ = build(tmp_path)
    handlers.handle(CHANNEL_KIND, channel_set(1, channel(), channel(AUDIO, kind="audio")))
    homeserver.broken.add(homeserver.aliases[f"#kodera-ch-{AUDIO}:{SERVER}"])

    outcome = handlers.handle(
        CHANNEL_KIND, channel_set(2, channel(members=[ALICE]), channel(AUDIO, kind="audio"))
    )

    assert (outcome.status, outcome.error_code) == ("failed", "service_unhealthy")
    assert outcome.artefacts["failed_channel_ids"] == [AUDIO]
    assert outcome.artefacts["channels_applied"] == 1
    assert homeserver.joined(TEXT) == {AGENT, mx(ALICE)}


def test_a_channel_no_longer_listed_has_its_room_emptied_and_archived(tmp_path):
    handlers, homeserver, livekit, _ = build(tmp_path)
    handlers.handle(CHANNEL_KIND, channel_set(1, channel(), channel(AUDIO, kind="audio")))
    room_id = homeserver.aliases[f"#kodera-ch-{AUDIO}:{SERVER}"]
    livekit.rooms_[livekit_room(room_id)] = [f"{mx(ALICE)}|D"]

    assert handlers.handle(CHANNEL_KIND, channel_set(2, channel())).status == "succeeded"

    assert homeserver.joined(AUDIO) == {AGENT}
    assert homeserver.room_of(AUDIO)["state"][(POLICY, "")]["archived"] is True
    assert livekit.removed == [(livekit_room(room_id), f"{mx(ALICE)}|D")]


def test_an_older_channel_set_never_undoes_a_newer_one(tmp_path):
    handlers, homeserver, _, _ = build(tmp_path)
    handlers.handle(CHANNEL_KIND, channel_set(5, channel(members=[ALICE])))
    outcome = handlers.handle(CHANNEL_KIND, channel_set(4, channel(members=[ALICE, BOB])))
    assert outcome.artefacts["revision_applied"] == 5
    assert homeserver.joined(TEXT) == {AGENT, mx(ALICE)}


def test_a_malformed_channel_set_touches_nothing(tmp_path):
    handlers, homeserver, _, _ = build(tmp_path)
    for broken in (
        {"revision": 0, "channels": []},
        channel_set(1, channel(kind="voice")),
        channel_set(1, channel(members=["has a space"])),
        channel_set(1, channel(channel_id="not-a-uuid")),
        channel_set(1, channel(), channel()),
        channel_set(1, channel(audience="all", members=[ALICE])),
        channel_set(1, channel(members=["sub-dave"])),  # not among all_members
        {"revision": 1, "channels": []},  # no all_members
    ):
        assert handlers.handle(CHANNEL_KIND, broken).error_code == "invalid_payload"
    assert homeserver.rooms == {}


def test_the_member_set_deactivates_and_reactivates_synapse_accounts(tmp_path):
    handlers, homeserver, _, _ = build(tmp_path)
    handlers.handle(CHANNEL_KIND, channel_set(1, channel()))

    first = handlers.handle(MEMBER_KIND, member_set(1, active=(ALICE,), inactive=(BOB,)))
    assert homeserver.accounts[mx(BOB)] is True and homeserver.joined(TEXT) == {AGENT, mx(ALICE)}
    assert first.artefacts["users_deactivated"] >= 1

    handlers.handle(MEMBER_KIND, member_set(2, active=(ALICE, BOB), inactive=(), released=(BOB,)))
    assert homeserver.accounts[mx(BOB)] is False
    handlers.reapply()  # the channel set in force joins him back
    assert homeserver.joined(TEXT) == {AGENT, mx(ALICE), mx(BOB)}


def test_the_guard_removes_whoever_the_channel_set_does_not_admit_to_an_audio_call(tmp_path):
    homeserver = FakeHomeserver()
    livekit = CallLiveKit({})
    handlers, _, _, _ = build(tmp_path, homeserver, livekit)
    handlers.handle(CHANNEL_KIND, channel_set(1, channel(AUDIO, kind="audio", members=[ALICE])))
    call = livekit_room(homeserver.aliases[f"#kodera-ch-{AUDIO}:{SERVER}"])
    livekit.rooms_[call] = [f"{mx(ALICE)}|D", f"{mx(CAROL)}|D"]

    report = handlers._guard.enforce(call)

    assert report.removed == [(call, f"{mx(CAROL)}|D")] and report.failed_rooms == 0


def test_the_alias_and_the_livekit_room_follow_their_fixed_rules():
    synapse = Synapse("http://x", "t", SERVER)
    assert synapse.alias(TEXT) == f"#kodera-ch-{TEXT}:{SERVER}"
    assert synapse.user_id("A1B2-c3") == f"@a1b2-c3:{SERVER}"
    assert synapse.user_id("no spaces") is None
    assert re.fullmatch(r"kodera-[0-9a-f]{32}", livekit_room("!abc:x"))


def test_an_erased_member_s_account_is_erased_once(tmp_path):
    handlers, homeserver, _, _ = build(tmp_path)
    erasing = {**member_set(1, active=(ALICE,), inactive=(BOB,)), "erased_subjects": [BOB]}

    first = handlers.handle(MEMBER_KIND, erasing)
    again = handlers.handle(MEMBER_KIND, {**erasing, "revision": 2})
    handlers.reapply()

    assert homeserver.erased == [(mx(BOB), True)] and homeserver.accounts[mx(BOB)] is True
    assert first.artefacts["users_erased"] == 1 and again.artefacts["users_erased"] == 0


def test_an_erased_subject_must_be_inactive(tmp_path):
    handlers, homeserver, _, _ = build(tmp_path)
    wrong = {**member_set(1, active=(ALICE,), inactive=(BOB,)), "erased_subjects": [ALICE]}
    assert handlers.handle(MEMBER_KIND, wrong).error_code == "invalid_payload"
    assert homeserver.erased == []


def test_a_channel_open_to_everyone_holds_all_members_less_the_denied(tmp_path):
    handlers, homeserver, _, _ = build(tmp_path)
    handlers.handle(
        CHANNEL_KIND, channel_set(1, channel(audience="all", members=[], denied=[CAROL]))
    )
    assert homeserver.joined(TEXT) == {AGENT, mx(ALICE), mx(BOB)}
    handlers.handle(CHANNEL_KIND, channel_set(2, channel(audience="all", members=[], denied=[])))
    assert homeserver.joined(TEXT) == {AGENT, mx(ALICE), mx(BOB), mx(CAROL)}


# --- a homeserver that does not answer, through the real transport --------------------------

THIRD = "44444444-4444-4444-8444-444444444444"


class DeadOpener:
    """Stands in for the HTTP opener: every request fails as a hung or refusing server does."""

    def __init__(self, error: BaseException) -> None:
        self.error, self.calls = error, 0

    def open(self, request, timeout):
        self.calls += 1
        raise self.error


@pytest.mark.parametrize(
    "error",
    [
        urllib.error.URLError(TimeoutError("timed out")),
        TimeoutError("timed out"),
        urllib.error.URLError(ConnectionRefusedError(61, "refused")),
        http.client.RemoteDisconnected("closed"),
    ],
)
def test_a_homeserver_that_does_not_answer_costs_one_call_and_fails_every_channel(
    tmp_path, caplog, error
):
    synapse = Synapse("http://synapse:8008", "agent-token", SERVER, ROOMS)
    synapse._opener = opener = DeadOpener(error)
    handlers, *_ = build(tmp_path, synapse)

    with caplog.at_level(logging.WARNING, logger="tenant_agent.channels"):
        outcome = handlers.handle(
            CHANNEL_KIND,
            channel_set(1, channel(TEXT), channel(AUDIO, kind="audio"), channel(THIRD)),
        )

    assert opener.calls == 1
    assert (outcome.status, outcome.error_code) == ("failed", "service_unhealthy")
    assert outcome.artefacts["failed_channel_ids"] == sorted([TEXT, AUDIO, THIRD])
    assert outcome.artefacts["channels_applied"] == 0
    assert len([r for r in caplog.records if r.name == "tenant_agent.channels"]) == 1


def test_an_http_error_is_one_channel_s_failure_not_an_unavailable_homeserver():
    synapse = Synapse("http://synapse:8008", "agent-token", SERVER)
    synapse._opener = DeadOpener(
        urllib.error.HTTPError("http://synapse:8008/x", 500, "boom", {}, None)
    )
    with pytest.raises(EngineError) as raised:
        synapse.resolve(TEXT)
    assert not isinstance(raised.value, SynapseUnavailableError)


def test_the_admin_token_never_follows_a_redirect():
    seen: list[str | None] = []

    class Elsewhere(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append(self.headers.get("Authorization"))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"room_id": "!x:elsewhere"}')

        def log_message(self, *args):
            pass

    elsewhere = http.server.HTTPServer(("127.0.0.1", 0), Elsewhere)

    class Redirecting(Elsewhere):
        def do_GET(self):
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{elsewhere.server_port}/stolen")
            self.end_headers()

    homeserver = http.server.HTTPServer(("127.0.0.1", 0), Redirecting)
    for server in (elsewhere, homeserver):
        threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        synapse = Synapse(f"http://127.0.0.1:{homeserver.server_port}", "agent-token", SERVER)
        with pytest.raises(EngineError, match="answered 302"):
            synapse.resolve(TEXT)
    finally:
        for server in (homeserver, elsewhere):
            server.shutdown()
            server.server_close()
    assert seen == []


def test_the_re_application_applies_the_member_set_before_the_channels(tmp_path, monkeypatch):
    handlers, *_ = build(tmp_path)
    handlers.handle(CHANNEL_KIND, channel_set(1, channel()))
    handlers.handle(MEMBER_KIND, member_set(1, active=(ALICE,), inactive=(BOB,)))
    order: list[str] = []
    apply, apply_channels = handlers.apply, handlers.apply_channels
    monkeypatch.setattr(
        handlers, "apply", lambda *a, **k: order.append("members") or apply(*a, **k)
    )
    monkeypatch.setattr(
        handlers,
        "apply_channels",
        lambda *a, **k: order.append("channels") or apply_channels(*a, **k),
    )

    handlers.reapply()

    assert order == ["members", "channels"]


# --- the truth of a report -------------------------------------------------------------------


def test_a_deleted_channel_s_room_that_is_not_emptied_fails_the_command(tmp_path):
    handlers, homeserver, _, _ = build(tmp_path)
    handlers.handle(CHANNEL_KIND, channel_set(1, channel(), channel(AUDIO, kind="audio")))
    audio_room = homeserver.aliases[f"#kodera-ch-{AUDIO}:{SERVER}"]
    homeserver.broken.add(audio_room)

    outcome = handlers.handle(CHANNEL_KIND, channel_set(2, channel()))

    assert (outcome.status, outcome.error_code) == ("failed", "service_unhealthy")
    # The listed channel converged; the deleted one is not in the set, so it is never named.
    assert outcome.artefacts["failed_channel_ids"] == []
    assert outcome.artefacts["channels_applied"] == 1
    assert "not emptied" in outcome.detail
    homeserver.broken.clear()
    assert handlers.handle(CHANNEL_KIND, channel_set(2, channel())).status == "succeeded"
    assert homeserver.joined(AUDIO) == {AGENT}


def test_a_room_under_a_channel_s_alias_that_the_agent_did_not_create_is_left_alone(tmp_path):
    handlers, homeserver, _, state = build(tmp_path)
    mallory = f"@mallory:{SERVER}"
    homeserver.rooms["!planted"] = {"state": {}, "members": {mallory: "join"}}
    homeserver.aliases[f"#kodera-ch-{TEXT}:{SERVER}"] = "!planted"
    homeserver.creators["!planted"] = mallory

    outcome = handlers.handle(CHANNEL_KIND, channel_set(1, channel()))

    assert outcome.artefacts["failed_channel_ids"] == [TEXT]
    assert homeserver.rooms["!planted"] == {"state": {}, "members": {mallory: "join"}}
    assert state.channel_rooms() == {}


def test_a_room_the_agent_made_is_recognised_after_its_state_is_lost(tmp_path):
    handlers, homeserver, _, state = build(tmp_path)
    handlers.handle(CHANNEL_KIND, channel_set(1, channel()))
    state.keep_channel_rooms({})

    assert handlers.handle(CHANNEL_KIND, channel_set(2, channel(members=[ALICE]))).status == (
        "succeeded"
    )
    assert len(homeserver.rooms) == 1 and homeserver.joined(TEXT) == {AGENT, mx(ALICE)}


def test_a_room_is_recorded_as_soon_as_it_is_made(tmp_path):
    """A channel whose converge fails after its room was made still has the room recorded, so
    the room is emptied once the channel is deleted."""
    homeserver = FakeHomeserver()
    handlers, _, _, state = build(tmp_path, homeserver)
    members = homeserver.members
    homeserver.members = lambda room_id: (_ for _ in ()).throw(EngineError("synapse answered 500"))
    assert handlers.handle(CHANNEL_KIND, channel_set(1, channel())).status == "failed"
    room_id = homeserver.aliases[f"#kodera-ch-{TEXT}:{SERVER}"]
    assert state.channel_rooms() == {TEXT: room_id}
    homeserver.rooms[room_id]["members"][mx(ALICE)] = "join"
    homeserver.members = members

    assert handlers.handle(CHANNEL_KIND, channel_set(2)).status == "succeeded"

    assert homeserver.joined(TEXT) == {AGENT}


# --- accounts --------------------------------------------------------------------------------


def test_a_failing_erasure_holds_back_no_deactivation(tmp_path):
    handlers, homeserver, _, _ = build(tmp_path)
    homeserver.unerasable.add(mx(BOB))
    erasing = {**member_set(1, active=(ALICE,), inactive=(BOB, CAROL)), "erased_subjects": [BOB]}

    outcome = handlers.handle(MEMBER_KIND, erasing)

    assert outcome.status == "failed"
    assert homeserver.accounts[mx(BOB)] is True and homeserver.accounts[mx(CAROL)] is True
    assert homeserver.erased == []


def test_an_erased_account_is_never_reactivated(tmp_path):
    handlers, homeserver, _, _ = build(tmp_path)
    handlers.handle(
        MEMBER_KIND, {**member_set(1, active=(ALICE,), inactive=(BOB,)), "erased_subjects": [BOB]}
    )

    again = handlers.handle(
        MEMBER_KIND, member_set(2, active=(ALICE, BOB), inactive=(), released=(BOB,))
    )

    assert again.status == "succeeded" and homeserver.accounts[mx(BOB)] is True  # Docs, Meet: yes


# --- what a member may no longer do ------------------------------------------------------------


def test_the_guard_removes_an_inactive_member_from_a_call_their_channel_still_admits(tmp_path):
    homeserver = FakeHomeserver()
    livekit = CallLiveKit({})
    handlers, *_ = build(tmp_path, homeserver, livekit)
    handlers.handle(CHANNEL_KIND, channel_set(1, channel(AUDIO, kind="audio")))
    call = livekit_room(homeserver.aliases[f"#kodera-ch-{AUDIO}:{SERVER}"])
    livekit.rooms_[call] = [f"{mx(ALICE)}|D", f"{mx(BOB)}|D"]

    handlers.handle(MEMBER_KIND, member_set(1, active=(ALICE, CAROL), inactive=(BOB,)))

    assert (call, f"{mx(BOB)}|D") in livekit.removed
    assert (call, f"{mx(ALICE)}|D") not in livekit.removed


def test_a_pending_invite_to_someone_no_longer_a_member_is_rescinded(tmp_path):
    handlers, homeserver, _, _ = build(tmp_path)
    handlers.handle(CHANNEL_KIND, channel_set(1, channel()))
    homeserver.room_of(TEXT)["members"][mx(CAROL)] = "invite"

    handlers.handle(CHANNEL_KIND, channel_set(2, channel()))

    assert homeserver.room_of(TEXT)["members"][mx(CAROL)] == "leave"


def test_an_archived_channel_takes_no_posts_and_ends_its_call(tmp_path):
    homeserver = FakeHomeserver()
    livekit = CallLiveKit({})
    handlers, *_ = build(tmp_path, homeserver, livekit)
    handlers.handle(CHANNEL_KIND, channel_set(1, channel(), channel(AUDIO, kind="audio")))
    call = livekit_room(homeserver.aliases[f"#kodera-ch-{AUDIO}:{SERVER}"])
    livekit.rooms_[call] = [f"{mx(ALICE)}|D", f"{mx(BOB)}|D"]

    handlers.handle(
        CHANNEL_KIND,
        channel_set(2, channel(archived=True), channel(AUDIO, kind="audio", archived=True)),
    )

    text = homeserver.room_of(TEXT)["state"]
    assert text[("m.room.power_levels", "")]["events_default"] == 100
    assert text[(POLICY, "")]["archived"] is True
    assert sorted(livekit.removed) == [(call, f"{mx(ALICE)}|D"), (call, f"{mx(BOB)}|D")]


def test_the_agent_bypasses_http_proxy_for_synapse_and_livekit(monkeypatch):
    """Both Synapse and LiveKit install `ProxyHandler({})` and `_NoRedirect()`, so `HTTP_PROXY` /
    `http_proxy` in the process environment never routes the admin token or LiveKit JWT through a
    proxy and neither client follows a 302 redirect."""
    import email
    import io
    import urllib.request

    for var in ("HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"):
        monkeypatch.setenv(var, "http://proxy.evil.invalid:8080")

    hosts: list[str] = []
    redirect = False

    class _Reply:
        status = code = 200
        msg = "OK"

        def info(self):
            return {}

        def read(self):
            return b'{"room_id": "!r:acme.kodera.io", "rooms": []}'

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

    def capture_http(req):
        hosts.append(req.host)
        if redirect:
            headers = email.message_from_string("Location: http://elsewhere.invalid/stolen\n")
            fp = io.BytesIO(b"")
            resp = urllib.response.addinfourl(fp, headers, req.full_url, 302)
            resp.msg = "Found"
            return resp
        return _Reply()

    synapse = Synapse("http://synapse.internal:8008", "agent-token", SERVER)
    livekit = LiveKit("http://livekit.internal:7880", "lk-key", "s" * 40)
    for client in (synapse, livekit):
        assert [
            h for h in client._opener.handlers if isinstance(h, urllib.request.ProxyHandler)
        ] == []
        http_handlers = [
            h for h in client._opener.handlers if isinstance(h, urllib.request.HTTPHandler)
        ]
        assert len(http_handlers) == 1
        monkeypatch.setattr(http_handlers[0], "http_open", capture_http)

    assert synapse.resolve(TEXT) == "!r:acme.kodera.io"
    assert livekit.rooms() == []
    assert hosts == ["synapse.internal:8008", "livekit.internal:7880"]

    hosts.clear()
    redirect = True
    with pytest.raises(EngineError, match="answered 302"):
        synapse.resolve(TEXT)
    with pytest.raises(EngineError, match="answered 302"):
        livekit.rooms()
    assert hosts == ["synapse.internal:8008", "livekit.internal:7880"]


def test_an_existing_agent_room_is_recorded_mid_pass_before_a_later_step_fails(tmp_path):
    """When `resolve` finds an existing room created by the agent that is not in `channel_rooms`
    yet, the room is recorded in state before membership convergence runs, so a failure later in
    `_converge` still leaves the room recorded for deletion."""
    homeserver = FakeHomeserver()
    handlers, _, _, state = build(tmp_path, homeserver)
    assert handlers.handle(CHANNEL_KIND, channel_set(1, channel())).status == "succeeded"
    room_id = homeserver.aliases[f"#kodera-ch-{TEXT}:{SERVER}"]
    state.keep_channel_rooms({})
    assert state.channel_rooms() == {}

    members = homeserver.members
    homeserver.members = lambda _room_id: (_ for _ in ()).throw(EngineError("synapse answered 500"))
    assert handlers.handle(CHANNEL_KIND, channel_set(2, channel())).status == "failed"
    assert state.channel_rooms() == {TEXT: room_id}

    homeserver.rooms[room_id]["members"][mx(ALICE)] = "join"
    homeserver.members = members
    assert handlers.handle(CHANNEL_KIND, channel_set(3)).status == "succeeded"
    assert homeserver.joined(TEXT) == {AGENT}


@pytest.mark.parametrize(
    "error",
    [
        urllib.error.URLError(TimeoutError("timed out")),
        TimeoutError("timed out"),
        urllib.error.URLError(ConnectionRefusedError(61, "refused")),
        http.client.RemoteDisconnected("closed"),
    ],
)
def test_a_hung_livekit_costs_one_call_across_audio_channels_and_guard_rooms(tmp_path, error):
    """A hung LiveKit stops further LiveKit calls in the same pass, costing one call instead of
    one timeout per audio channel or guard room, while text channels still converge."""
    second_audio = "44444444-4444-4444-8444-444444444444"
    homeserver = FakeHomeserver()
    livekit = LiveKit("http://livekit:7880", "lk-key", "s" * 40)
    livekit._opener = opener = DeadOpener(error)
    handlers, _, _, state = build(tmp_path, homeserver, livekit)

    assert (
        handlers.handle(
            CHANNEL_KIND,
            channel_set(
                1,
                channel(TEXT),
                channel(AUDIO, kind="audio"),
                channel(second_audio, kind="audio"),
            ),
        ).status
        == "succeeded"
    )
    assert opener.calls == 0

    outcome = handlers.handle(
        CHANNEL_KIND,
        channel_set(
            2,
            channel(TEXT, topic="updated"),
            channel(AUDIO, kind="audio", archived=True),
            channel(second_audio, kind="audio", archived=True),
        ),
    )

    assert opener.calls == 1
    assert (outcome.status, outcome.error_code) == ("failed", "service_unhealthy")
    assert outcome.artefacts["failed_channel_ids"] == sorted([AUDIO, second_audio])
    assert outcome.artefacts["channels_applied"] == 1
    assert homeserver.room_of(TEXT)["state"][("m.room.topic", "")]["topic"] == "updated"

    # RosterGuard also stops after the first hung LiveKit room check.
    guard_livekit = LiveKit("http://livekit:7880", "lk-key", "s" * 40)
    guard_opener = DeadOpener(error)
    guard_livekit.rooms = lambda: ["kodera-1", "kodera-2", "kodera-3"]
    guard_livekit._opener = guard_opener
    guard = RosterGuard(guard_livekit, Meet(FakeRunner(), "meet-backend"), state, homeserver)
    report = guard.enforce()
    assert guard_opener.calls == 1
    assert report.rooms == 3 and report.failed_rooms == 3


# --- removals first, and only what changed ----------------------------------------------------

FIRST, SECOND, LAST = (
    "55555555-5555-4555-8555-555555555555",
    "66666666-6666-4666-8666-666666666666",
    "77777777-7777-4777-8777-777777777777",
)
NEW = "88888888-8888-4888-8888-888888888888"


def room_id_of(homeserver, channel_id):
    """The channel's room id as the request paths carry it."""
    return urllib.parse.quote(homeserver.aliases[f"#kodera-ch-{channel_id}:{SERVER}"], safe="")


def is_kick(write):
    return write.endswith("/kick")


def test_every_removal_comes_before_any_create_join_or_state_write(tmp_path):
    handlers, homeserver, _, _ = build(tmp_path)
    ids = (FIRST, SECOND, LAST)
    handlers.handle(CHANNEL_KIND, channel_set(1, *(channel(i) for i in ids)))
    homeserver.writes.clear()

    # Bob leaves all three, each is renamed, Carol joins each, and a new channel is made.
    outcome = handlers.handle(
        CHANNEL_KIND,
        channel_set(
            2,
            *(channel(i, name=f"renamed-{n}", members=[ALICE, CAROL]) for n, i in enumerate(ids)),
            channel(NEW),
        ),
    )

    assert outcome.status == "succeeded"
    kicks = [n for n, w in enumerate(homeserver.writes) if is_kick(w)]
    others = [n for n, w in enumerate(homeserver.writes) if not is_kick(w)]
    assert len(kicks) == 3 and len(others) >= 3 + 3 + 1
    assert max(kicks) < min(others)
    assert any(w.endswith("/createRoom") for w in homeserver.writes)
    for i in ids:
        assert homeserver.joined(i) == {AGENT, mx(ALICE), mx(CAROL)}


def test_a_removal_in_the_last_channel_does_not_wait_for_the_first_channels_writes(tmp_path):
    handlers, homeserver, _, _ = build(tmp_path)
    handlers.handle(CHANNEL_KIND, channel_set(1, channel(FIRST), channel(SECOND), channel(LAST)))
    homeserver.writes.clear()

    handlers.handle(
        CHANNEL_KIND,
        channel_set(
            2,
            channel(FIRST, name="one", topic="changed"),
            channel(SECOND, name="two", read_only=True),
            channel(LAST, members=[ALICE]),
        ),
    )

    assert (
        homeserver.writes[0] == f"POST /_matrix/client/v3/rooms/{room_id_of(homeserver, LAST)}/kick"
    )
    assert sum("/state/" in w for w in homeserver.writes[1:]) >= 4
    assert homeserver.joined(LAST) == {AGENT, mx(ALICE)}


def test_an_unchanged_channel_reads_and_writes_no_state_on_the_next_application(tmp_path):
    handlers, homeserver, _, _ = build(tmp_path)
    channels = (channel(FIRST), channel(SECOND, kind="audio"), channel(LAST, read_only=True))
    handlers.handle(CHANNEL_KIND, channel_set(1, *channels))
    homeserver.reads.clear()
    homeserver.writes.clear()

    assert handlers.handle(CHANNEL_KIND, channel_set(2, *channels)).status == "succeeded"

    # Only the membership check: one read per room, nothing resolved, nothing written.
    assert homeserver.writes == []
    assert sorted(homeserver.reads) == sorted(
        f"GET /_matrix/client/v3/rooms/{room_id_of(homeserver, i)}/members"
        for i in (FIRST, SECOND, LAST)
    )


def test_a_removal_alone_reads_no_state_and_kicks(tmp_path):
    # Who the room holds is not part of its state: removing a member leaves the fingerprint as it
    # was, so the removal costs the membership read and the kick, and nothing else.
    handlers, homeserver, _, _ = build(tmp_path)
    handlers.handle(CHANNEL_KIND, channel_set(1, channel(FIRST), channel(SECOND)))
    homeserver.reads.clear()
    homeserver.writes.clear()

    handlers.handle(CHANNEL_KIND, channel_set(2, channel(FIRST), channel(SECOND, members=[ALICE])))

    assert not [r for r in homeserver.reads if "/state/" in r or "/directory/" in r]
    assert homeserver.writes == [
        f"POST /_matrix/client/v3/rooms/{room_id_of(homeserver, SECOND)}/kick"
    ]
    assert homeserver.joined(SECOND) == {AGENT, mx(ALICE)}


def test_a_changed_name_re_applies_that_channel_only(tmp_path):
    handlers, homeserver, _, _ = build(tmp_path)
    handlers.handle(CHANNEL_KIND, channel_set(1, channel(FIRST), channel(SECOND), channel(LAST)))
    homeserver.reads.clear()
    homeserver.writes.clear()

    handlers.handle(
        CHANNEL_KIND,
        channel_set(2, channel(FIRST), channel(SECOND, name="renamed"), channel(LAST)),
    )

    second = room_id_of(homeserver, SECOND)
    state_reads = [r for r in homeserver.reads if "/state/" in r]
    assert len(state_reads) == 4 and all(f"/rooms/{second}/" in r for r in state_reads)
    assert homeserver.writes == [f"PUT /_matrix/client/v3/rooms/{second}/state/m.room.name/"]
    assert homeserver.room_of(SECOND)["state"][("m.room.name", "")] == {"name": "renamed"}


def test_the_full_re_application_ignores_the_fingerprints_and_repairs_drift(tmp_path):
    handlers, homeserver, _, _ = build(tmp_path)
    handlers.handle(CHANNEL_KIND, channel_set(1, channel(FIRST), channel(SECOND)))
    homeserver.room_of(SECOND)["state"][("m.room.topic", "")] = {"topic": "changed by hand"}

    handlers.handle(CHANNEL_KIND, channel_set(1, channel(FIRST), channel(SECOND)))
    assert homeserver.room_of(SECOND)["state"][("m.room.topic", "")] == {"topic": "changed by hand"}
    homeserver.reads.clear()

    handlers.reapply()

    assert homeserver.room_of(SECOND)["state"][("m.room.topic", "")] == {"topic": ""}
    for i in (FIRST, SECOND):
        assert sum(f"/rooms/{room_id_of(homeserver, i)}/state/" in r for r in homeserver.reads) == 4


def test_a_channel_that_fails_records_no_fingerprint(tmp_path):
    handlers, homeserver, _, _ = build(tmp_path)
    handlers.handle(CHANNEL_KIND, channel_set(1, channel(FIRST), channel(SECOND)))
    second = room_id_of(homeserver, SECOND)
    homeserver.broken.add(homeserver.aliases[f"#kodera-ch-{SECOND}:{SERVER}"])

    failed = handlers.handle(
        CHANNEL_KIND, channel_set(2, channel(FIRST, name="a"), channel(SECOND, name="b"))
    )
    assert failed.artefacts["failed_channel_ids"] == [SECOND]
    assert failed.artefacts["channels_applied"] == 1
    homeserver.broken.clear()
    homeserver.reads.clear()

    again = handlers.handle(
        CHANNEL_KIND, channel_set(2, channel(FIRST, name="a"), channel(SECOND, name="b"))
    )

    assert again.status == "succeeded"
    assert not [
        r for r in homeserver.reads if f"/rooms/{room_id_of(homeserver, FIRST)}/state/" in r
    ]
    assert sum(f"/rooms/{second}/state/" in r for r in homeserver.reads) == 4
    assert homeserver.room_of(SECOND)["state"][("m.room.name", "")] == {"name": "b"}


def test_a_channel_whose_removal_fails_is_named_and_still_converges_the_rest(tmp_path):
    handlers, homeserver, _, _ = build(tmp_path)
    handlers.handle(CHANNEL_KIND, channel_set(1, channel(FIRST), channel(SECOND)))
    kick = homeserver.kick

    def refuse(room_id, user):
        if room_id == homeserver.aliases[f"#kodera-ch-{FIRST}:{SERVER}"]:
            raise EngineError("synapse answered 500")
        kick(room_id, user)

    homeserver.kick = refuse
    outcome = handlers.handle(
        CHANNEL_KIND,
        channel_set(2, channel(FIRST, members=[ALICE]), channel(SECOND, members=[ALICE])),
    )

    assert outcome.artefacts["failed_channel_ids"] == [FIRST]
    assert outcome.artefacts["channels_applied"] == 1
    assert homeserver.joined(SECOND) == {AGENT, mx(ALICE)}
    homeserver.kick = kick
    assert handlers.handle(
        CHANNEL_KIND,
        channel_set(2, channel(FIRST, members=[ALICE]), channel(SECOND, members=[ALICE])),
    ).status == ("succeeded")
    assert homeserver.joined(FIRST) == {AGENT, mx(ALICE)}


def test_a_homeserver_that_stops_answering_mid_removals_fails_every_channel(tmp_path, caplog):
    # Rooms already recorded: the removals run on the pool, and once one call finds the homeserver
    # gone no worker starts another, so the pass costs at most one call per worker.
    ids = [f"{n:08x}-0000-4000-8000-000000000000" for n in range(10)]
    state = State(tmp_path)
    state.keep_channel_rooms({i: f"!r{n}:{SERVER}" for n, i in enumerate(ids)})
    synapse = Synapse("http://synapse:8008", "agent-token", SERVER, ROOMS)
    synapse._me = AGENT
    synapse._opener = opener = DeadOpener(urllib.error.URLError(TimeoutError("timed out")))
    handlers, *_ = build(tmp_path, synapse)

    with caplog.at_level(logging.WARNING, logger="tenant_agent.channels"):
        outcome = handlers.handle(CHANNEL_KIND, channel_set(1, *(channel(i) for i in ids)))

    assert 1 <= opener.calls <= 4
    assert outcome.artefacts["failed_channel_ids"] == sorted(ids)
    assert outcome.artefacts["channels_applied"] == 0
    assert len([r for r in caplog.records if r.name == "tenant_agent.channels"]) == 1


class OrderedLiveKit(CallLiveKit):
    """Records its removals in the homeserver's write log, so the two orders can be compared."""

    def __init__(self, homeserver):
        super().__init__({})
        self.homeserver = homeserver

    def remove(self, room, identity):
        self.homeserver.writes.append(f"livekit remove {identity}")
        super().remove(room, identity)


def test_an_archived_audio_channel_is_closed_before_its_call_is_ended(tmp_path):
    # Ending the call first would let a member rejoin it, their token still valid, until the
    # archived policy reached the room: the closing writes go first, ahead of other channels.
    homeserver = FakeHomeserver()
    livekit = OrderedLiveKit(homeserver)
    handlers, *_ = build(tmp_path, homeserver, livekit)
    handlers.handle(CHANNEL_KIND, channel_set(1, channel(FIRST), channel(AUDIO, kind="audio")))
    call = livekit_room(homeserver.aliases[f"#kodera-ch-{AUDIO}:{SERVER}"])
    livekit.rooms_[call] = [f"{mx(ALICE)}|D"]
    homeserver.writes.clear()

    handlers.handle(
        CHANNEL_KIND,
        channel_set(2, channel(FIRST, name="later"), channel(AUDIO, kind="audio", archived=True)),
    )

    audio = room_id_of(homeserver, AUDIO)
    assert homeserver.writes[:3] == [
        f"PUT /_matrix/client/v3/rooms/{audio}/state/{POLICY}/",
        f"PUT /_matrix/client/v3/rooms/{audio}/state/m.room.power_levels/",
        f"livekit remove {mx(ALICE)}|D",
    ]
    assert homeserver.room_of(AUDIO)["state"][(POLICY, "")]["archived"] is True


def test_a_channel_that_fails_in_the_full_pass_loses_its_fingerprint(tmp_path):
    # Its fingerprint matched, but the full pass found drift and could not repair it: the next
    # received set must look at its state again, not skip it.
    handlers, homeserver, _, _ = build(tmp_path)
    handlers.handle(CHANNEL_KIND, channel_set(1, channel(FIRST)))
    homeserver.room_of(FIRST)["state"][("m.room.topic", "")] = {"topic": "changed by hand"}
    put_state = homeserver.put_state

    def refuse(room_id, event_type, content):
        raise EngineError("synapse answered 500")

    homeserver.put_state = refuse
    handlers.reapply()
    homeserver.put_state = put_state

    assert handlers.handle(CHANNEL_KIND, channel_set(1, channel(FIRST))).status == "succeeded"
    assert homeserver.room_of(FIRST)["state"][("m.room.topic", "")] == {"topic": ""}


def test_a_pass_that_stops_halfway_leaves_no_fingerprint_naming_state_it_did_not_finish(tmp_path):
    # The agent stops after its first state write (a crash, here an unexpected error); the set
    # then goes back to what it was. The room holds the half-written state, so it must be re-read.
    handlers, homeserver, _, _ = build(tmp_path)
    handlers.handle(CHANNEL_KIND, channel_set(1, channel(FIRST, name="before", topic="t1")))
    put_state = homeserver.put_state

    def crash(room_id, event_type, content):
        put_state(room_id, event_type, content)
        raise RuntimeError("the agent stops here")

    homeserver.put_state = crash
    stopped = handlers.handle(
        CHANNEL_KIND, channel_set(2, channel(FIRST, name="after", topic="t2"))
    )
    assert stopped.error_code == "internal_error"
    assert homeserver.room_of(FIRST)["state"][("m.room.name", "")] == {"name": "after"}
    homeserver.put_state = put_state

    handlers.handle(CHANNEL_KIND, channel_set(3, channel(FIRST, name="before", topic="t1")))

    assert homeserver.room_of(FIRST)["state"][("m.room.name", "")] == {"name": "before"}


# --- review: what an unreachable engine must not hide -----------------------------------------


def test_deleting_channels_while_the_homeserver_is_unreachable_fails_the_command(tmp_path):
    # Nothing listed to fail, and the pass stops before the deleted room is reached: the room
    # still holds its members, so the command must fail and Core retry it.
    state = State(tmp_path)
    state.keep_channel_rooms({TEXT: f"!r0:{SERVER}"})
    synapse = Synapse("http://synapse:8008", "agent-token", SERVER, ROOMS)
    synapse._opener = DeadOpener(urllib.error.URLError(TimeoutError("timed out")))
    handlers, *_ = build(tmp_path, synapse)

    outcome = handlers.handle(CHANNEL_KIND, channel_set(1))

    assert (outcome.status, outcome.error_code) == ("failed", "service_unhealthy")
    assert "synapse did not answer" in outcome.detail and "not emptied" in outcome.detail
    assert state.channel_rooms() == {TEXT: f"!r0:{SERVER}"}


class FlakyLiveKit(CallLiveKit):
    down = False
    asked = 0

    def participants(self, room):
        self.asked += 1
        if self.down:
            raise LiveKitUnavailableError("livekit: timed out")
        return super().participants(room)


def test_a_call_left_open_because_livekit_was_down_is_ended_by_the_next_application(tmp_path):
    homeserver = FakeHomeserver()
    livekit = FlakyLiveKit({})
    handlers, *_ = build(tmp_path, homeserver, livekit)
    handlers.handle(CHANNEL_KIND, channel_set(1, channel(TEXT), channel(AUDIO, kind="audio")))
    call = livekit_room(homeserver.aliases[f"#kodera-ch-{AUDIO}:{SERVER}"])
    livekit.rooms_[call] = [f"{mx(ALICE)}|D", f"{mx(BOB)}|D"]
    removal = channel_set(
        2, channel(TEXT, members=[ALICE]), channel(AUDIO, kind="audio", members=[ALICE])
    )

    livekit.down = True
    first = handlers.handle(CHANNEL_KIND, removal)

    # The kicks went through; LiveKit failing names the audio channel only.
    assert first.artefacts["failed_channel_ids"] == [AUDIO]
    assert first.artefacts["channels_applied"] == 1
    assert homeserver.joined(AUDIO) == homeserver.joined(TEXT) == {AGENT, mx(ALICE)}
    assert livekit.rooms_[call] == [f"{mx(ALICE)}|D", f"{mx(BOB)}|D"]

    livekit.down = False
    # Bob is no longer in the room, so no kick this time: the owed call is what ends his.
    second = handlers.handle(CHANNEL_KIND, removal)

    assert second.status == "succeeded"
    assert livekit.rooms_[call] == [f"{mx(ALICE)}|D"]
    livekit.asked = 0
    handlers.handle(CHANNEL_KIND, removal)
    assert livekit.asked == 0  # settled: nothing owed any more, LiveKit is not asked again


def test_the_removals_of_different_rooms_run_at_the_same_time(tmp_path):
    # Each kick waits for a second one to be in flight: run one after the other, the first times
    # out and the command fails, rather than hanging.
    homeserver = FakeHomeserver()
    handlers, *_ = build(tmp_path, homeserver)
    handlers.handle(CHANNEL_KIND, channel_set(1, channel(FIRST), channel(SECOND)))
    together = threading.Barrier(2, timeout=2)
    kick = homeserver.kick

    def kick_together(room_id, user):
        together.wait()
        kick(room_id, user)

    homeserver.kick = kick_together

    outcome = handlers.handle(
        CHANNEL_KIND,
        channel_set(2, channel(FIRST, members=[ALICE]), channel(SECOND, members=[ALICE])),
    )

    assert outcome.status == "succeeded"
    assert homeserver.joined(FIRST) == homeserver.joined(SECOND) == {AGENT, mx(ALICE)}


def test_an_application_that_changes_no_fingerprint_does_not_rewrite_them(tmp_path):
    handlers, _, _, state = build(tmp_path)
    handlers.handle(CHANNEL_KIND, channel_set(1, channel(FIRST), channel(SECOND)))
    path = tmp_path / "channel_fingerprints.json"
    old = path.stat().st_mtime_ns - 10**9
    os.utime(path, ns=(old, old))

    handlers.handle(CHANNEL_KIND, channel_set(2, channel(FIRST), channel(SECOND, members=[ALICE])))

    assert path.stat().st_mtime_ns == old


def test_an_unreachable_homeserver_is_never_reported_succeeded(tmp_path):
    synapse = Synapse("http://synapse:8008", "agent-token", SERVER, ROOMS)
    synapse._opener = DeadOpener(urllib.error.URLError(TimeoutError("timed out")))
    handlers, *_ = build(tmp_path, synapse)

    outcome = handlers.handle(CHANNEL_KIND, channel_set(1))

    assert (outcome.status, outcome.error_code) == ("failed", "service_unhealthy")


class CrashingLiveKit(CallLiveKit):
    crash = False

    def participants(self, room):
        if self.crash:
            raise RuntimeError("the agent stops here")
        return super().participants(room)


def test_a_call_owed_by_the_second_phase_survives_a_crash_before_livekit_answers(tmp_path):
    # The room is found under its alias (its record lost), so its removal runs in the second
    # phase; the agent stops between the kick and LiveKit. The owed call is on disk already.
    homeserver = FakeHomeserver()
    livekit = CrashingLiveKit({})
    handlers, _, _, state = build(tmp_path, homeserver, livekit)
    handlers.handle(CHANNEL_KIND, channel_set(1, channel(AUDIO, kind="audio")))
    room_id = homeserver.aliases[f"#kodera-ch-{AUDIO}:{SERVER}"]
    call = livekit_room(room_id)
    livekit.rooms_[call] = [f"{mx(ALICE)}|D", f"{mx(BOB)}|D"]
    state.keep_channel_rooms({})
    removal = channel_set(2, channel(AUDIO, kind="audio", members=[ALICE]))

    livekit.crash = True
    assert handlers.handle(CHANNEL_KIND, removal).error_code == "internal_error"
    assert homeserver.joined(AUDIO) == {AGENT, mx(ALICE)}
    assert state.calls_owed() == {room_id}

    livekit.crash = False
    assert handlers.handle(CHANNEL_KIND, removal).status == "succeeded"
    assert livekit.rooms_[call] == [f"{mx(ALICE)}|D"]
    assert state.calls_owed() == set()


def test_an_archived_audio_channel_does_not_rewrite_the_owed_calls_each_pass(tmp_path):
    # Its call is checked on every pass anyway: nothing needs recording, so the file is untouched.
    homeserver = FakeHomeserver()
    livekit = CallLiveKit({})
    handlers, *_ = build(tmp_path, homeserver, livekit)
    handlers.handle(CHANNEL_KIND, channel_set(1, channel(AUDIO, kind="audio", archived=True)))
    call = livekit_room(homeserver.aliases[f"#kodera-ch-{AUDIO}:{SERVER}"])
    livekit.rooms_[call] = [f"{mx(ALICE)}|D"]

    handlers.handle(CHANNEL_KIND, channel_set(1, channel(AUDIO, kind="audio", archived=True)))
    handlers.handle(CHANNEL_KIND, channel_set(1, channel(AUDIO, kind="audio", archived=True)))

    assert livekit.rooms_[call] == []
    assert not (tmp_path / "calls_owed.json").exists()
