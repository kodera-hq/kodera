"""`engine_set_channel_members` (ADR-0018, agent-api 0.5.0): converge the tenant's Matrix rooms to
the organisation's Espace channels.

For each channel the room exists under its alias, carries its name, topic and
`io.kodera.room.policy`, holds exactly its members, and has the power levels `read_only` asks for.
A member removed from an audio room also leaves its live call. A room made for a channel the set no
longer lists is emptied and archived.

An application runs in two phases, because a removal must close access within seconds of the
admin's click whatever the number of channels. The first takes access away, in every room the agent
has recorded: it reads each room's membership once and kicks whoever the channel no longer holds,
on a small pool of workers, one room per task; it then ends, one room after the other so a LiveKit
that does not answer still costs one call, the live call of each audio room it kicked someone from:
everyone whose Matrix user the channel does not hold leaves (everyone, in an archived channel). The
room is recorded as owing that check before LiveKit is asked, and forgotten once LiveKit has
answered, so a call LiveKit could not end is ended by a later application although no one is left
to kick; an archived channel's call is checked on every pass, so it is never recorded. It then empties and archives the rooms of deleted channels. The pool is there for large
sets (up to `MAX_CHANNELS`, 500): at the pilot's channel counts a sequential pass would do. An
archived channel whose state was not yet applied has its policy and power levels written before its
call is ended: ending the call first would let a member back in until the policy reached the room. The
second phase does the rest, channel by channel: it finds or creates each room, converges its
state, joins whoever is missing and posts the notices. It reuses the membership the first phase
read, less the members kicked. Canonical community rooms with audience `all` and no deny
exceptions use native public joins, restricted by the policy module to local users, and skip
per-user joining. Other rooms remain invitation-only and restore missing members.

The room state last applied whole to a channel's room is fingerprinted in the agent's state: the
digest of the policy, power levels, name and topic the channel asks for, which are all its state
depends on. A channel whose room is recorded and whose fingerprint matches skips its alias, its
creator and its state, and gets only the membership check. A channel that fails, in either phase,
loses its fingerprint, and a stale one is dropped before anything is written. The periodic
re-application is `full` and ignores the fingerprints: it re-reads every room's state and repairs
any drift. Two cases are left to that full pass: a homeserver restored from a backup on its own,
whose rooms went back to older state while the fingerprints still match; and a full pass stopped
by a crash halfway through repairing a room, whose fingerprint still names the state it was
repairing towards.

Each channel converges on its own: one that fails is reported in `failed_channel_ids`, and the
others are applied. A homeserver that does not answer at all ends the pass at once, every channel
left reported failed, so a hung Synapse costs one timeout (at most one call per worker in flight)
and not one per channel; every recorded room of a deleted channel not yet emptied is then reported
not closed, so the command fails and Core retries it. Applying a set twice changes nothing.

A room is recorded in the agent's state as soon as it is created or found, and a room found under a
channel's alias is the channel's only if the agent created it.
"""

import hashlib
import json
import logging
import re
import threading
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

from .engines import EngineError, LiveKit, LiveKitUnavailableError
from .synapse import OCCUPANCY, POLICY, Synapse, SynapseUnavailableError, livekit_room

log = logging.getLogger("tenant_agent.channels")
CHANNEL_KIND = "engine_set_channel_members"
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_SUBJECT = re.compile(r"[\x21-\x7e]{1,255}")
MAX_CHANNELS, MAX_MEMBERS = 500, 10_000
# ESPACE_STRUCTURE.md §12: read-only posting at 20, held by owners and admins; the room-access
# account at 10, below kick, ban, redact and invite (50).
AGENT_LEVEL, MODERATION_LEVEL, POST_LEVEL, OCCUPANCY_LEVEL = 100, 50, 20, 10
# Removals across rooms run on this many workers: Synapse persists each room's events in turn but
# serves different rooms at once. Small, so a pass never floods the tenant's homeserver.
REMOVAL_WORKERS = 4
POWER_LEVELS = "m.room.power_levels"
JOIN_RULES = "m.room.join_rules"


def native_public(channel: dict[str, Any], synapse: Synapse) -> bool:
    """Only the canonical community namespace permits local native joins.

    A deny override, restricted audience or archive always restores invitation-only access.
    Customer homeservers retain their existing membership convergence.
    """
    return (
        synapse.server_name.startswith("community.")
        and channel["audience"] == "all"
        and not channel["denied"]
        and not channel["archived"]
    )


@dataclass(frozen=True)
class ChannelSet:
    revision: int
    channels: tuple[dict[str, Any], ...]
    all_members: frozenset[str] = frozenset()


def room_members(channel: dict[str, Any], all_members: frozenset[str]) -> list[str]:
    """Who the room holds: everyone less `denied` (`audience: all`), or its `members`."""
    if channel["audience"] == "all":
        return sorted(all_members - set(channel["denied"]))
    return list(channel["members"])


def _subjects(value: Any) -> bool:
    return (
        isinstance(value, list)
        and len(set(value)) == len(value)
        and all(isinstance(s, str) and _SUBJECT.fullmatch(s) for s in value)
    )


def parse(payload: dict[str, Any]) -> ChannelSet | None:
    """The set, or None when it breaks the contract: then nothing is touched."""
    revision, channels = payload.get("revision"), payload.get("channels")
    everyone = payload.get("all_members")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        return None
    if not isinstance(channels, list) or len(channels) > MAX_CHANNELS:
        return None
    if not isinstance(everyone, list) or not _subjects(everyone):
        return None
    all_members = frozenset(everyone)
    seen, members = set(), len(all_members)
    for channel in channels:
        if not isinstance(channel, dict):
            return None
        channel_id = channel.get("channel_id")
        if not isinstance(channel_id, str) or not _UUID.fullmatch(channel_id) or channel_id in seen:
            return None
        seen.add(channel_id)
        if channel.get("kind") not in ("text", "audio"):
            return None
        name, topic = channel.get("name"), channel.get("topic")
        if not isinstance(name, str) or not 1 <= len(name) <= 100 or not isinstance(topic, str):
            return None
        if not all(
            isinstance(channel.get(k), bool) for k in ("archived", "read_only", "listen_only")
        ):
            return None
        if not all(_subjects(channel.get(k)) for k in ("members", "denied", "exempt")):
            return None
        audience = channel.get("audience")
        if audience not in ("all", "listed"):
            return None
        if (audience == "all" and channel["members"]) or (
            audience == "listed" and channel["denied"]
        ):
            return None
        if not set(channel["members"]) | set(channel["denied"]) <= all_members:
            return None
        if not set(channel["exempt"]) <= set(room_members(channel, all_members)):
            return None
        notices = channel.get("notices")
        if not isinstance(notices, list) or not all(
            isinstance(n, dict)
            and isinstance(n.get("notice_id"), str)
            and _UUID.fullmatch(n["notice_id"])
            and isinstance(n.get("body"), str)
            and 1 <= len(n["body"]) <= 500
            for n in notices
        ):
            return None
        members += len(channel["members"]) + len(channel["denied"]) + len(channel["exempt"])
    if members > MAX_MEMBERS:
        return None
    return ChannelSet(revision, tuple(channels), all_members)


def power_levels(channel: dict[str, Any], synapse: Synapse, exempt: list[str]) -> dict[str, Any]:
    """Every state change is the agent's; members post at 0 unless the channel is read-only (or
    archived), when only the exempt, at the posting level, may. Reactions stay open in a read-only
    channel. The room-access account writes occupancy and nothing else.

    Rooms are created at room version 12, where the creator (the agent) holds unlimited power and
    must not be listed in `users`: Synapse refuses a power-levels event that names it."""
    users: dict[str, int] = {}
    closed = channel["archived"] or (channel["kind"] == "text" and channel["read_only"])
    if closed and not channel["archived"]:
        users.update({user: POST_LEVEL for user in exempt})
    if channel["kind"] == "audio" and synapse.room_access_user:
        users[synapse.room_access_user] = OCCUPANCY_LEVEL
    return {
        "users": users,
        "users_default": 0,
        "events_default": AGENT_LEVEL if channel["archived"] else POST_LEVEL if closed else 0,
        "state_default": AGENT_LEVEL,
        "invite": AGENT_LEVEL,
        "kick": AGENT_LEVEL,
        "ban": AGENT_LEVEL,
        "redact": MODERATION_LEVEL,
        "events": {
            "m.reaction": 0,
            # Deleting one's own earlier messages stays allowed in a read-only channel (§6).
            "m.room.redaction": 0,
            "m.room.encryption": AGENT_LEVEL,
            POLICY: AGENT_LEVEL,
            OCCUPANCY: OCCUPANCY_LEVEL,
        },
        "notifications": {"room": MODERATION_LEVEL},
    }


def policy(channel: dict[str, Any], exempt: list[str], members: frozenset[str]) -> dict[str, Any]:
    return {
        "version": 1,
        "kind": channel["kind"],
        "read_only": channel["read_only"],
        "audience": channel["audience"],
        "members": sorted(members) if channel["audience"] == "listed" else [],
        "exempt": sorted(exempt),
        "listen_only": channel["listen_only"],
        "may_publish": sorted(exempt) if channel["listen_only"] else [],
        "archived": channel["archived"],
    }


@dataclass
class Applied:
    channels_applied: int = 0
    failed: list[str] = field(default_factory=list)
    notices_posted: int = 0
    removed_from_calls: int = 0
    # Members with no account, and none could be made: joined once they first sign in
    # (`Channels.signed_in`).
    waiting: set[str] = field(default_factory=set)
    not_closed: list[str] = field(default_factory=list)  # deleted channels whose room still holds
    unavailable: bool = False
    livekit_unavailable: bool = False


@dataclass(frozen=True)
class _Wanted:
    """What one channel asks of its room."""

    users: frozenset[str]  # the Matrix users it holds
    state: tuple[
        tuple[str, dict[str, Any]], ...
    ]  # (event type, content): policy, levels, name, topic
    digest: str

    @property
    def closing(self) -> tuple[tuple[str, dict[str, Any]], ...]:
        """The state that takes access away: the policy and the power levels."""
        return self.state[:2]


class _Owed:
    """The audio rooms owing a call check (see `State.calls_owed`), saved only when they change."""

    def __init__(self, state: Any) -> None:
        self._state = state
        self.rooms: set[str] = state.calls_owed()
        self._saved = set(self.rooms)

    def save(self) -> None:
        if self.rooms != self._saved:
            self._state.keep_calls_owed(self.rooms)
            self._saved = set(self.rooms)


class Channels:
    def __init__(
        self, synapse: Synapse, livekit: LiveKit, state: Any, workers: int = REMOVAL_WORKERS
    ) -> None:
        self._synapse, self._livekit, self._state = synapse, livekit, state
        self._workers = max(1, workers)
        # Who the last application could not join for want of an account. In memory only: the
        # agent re-applies the set in force when it starts, which finds them again.
        self.waiting: frozenset[str] = frozenset()
        # This pass's active member users → their realm subjects: the only users joined.
        self._subjects: dict[str, str] = {}
        self._barred: set[str] = set()  # erased accounts, never joined again

    def _accounts_owed(self, channel_set: ChannelSet) -> None:
        """Who `_join` may join, and make an account for (`Synapse.create_account`): a member the
        set names whom the member set in force holds active. Anyone else is never joined nor given
        an account: a subject held inactive (an erased person's included) or released, anyone at
        all while no member set is stored, and an account the erasure ledger holds. Revocation
        wins even against a set that still names the member."""
        synapse = self._synapse
        members = self._state.member_set()
        active = frozenset() if members is None else members.active
        self._subjects = {
            user: subject
            for channel in channel_set.channels
            for subject in room_members(channel, channel_set.all_members)
            if subject in active and (user := synapse.user_id(subject)) is not None
        }
        self._barred = set(self._state.erased_accounts())

    def _join(self, room_id: str, user: str, waiting: set[str]) -> None:
        """Join a member the room lacks. The account is read first: Synapse's admin join joins a
        deactivated account too. A missing one is made first, and the member waits for their
        first sign-in only when none could be made; a deactivated one, a member not held
        active, or one barred, is not joined and does not wait."""
        synapse = self._synapse
        subject = self._subjects.get(user)
        if subject is None or user in self._barred:
            return
        found = synapse.account(user)
        if found is None:
            if not synapse.create_account(user, subject):
                waiting.add(user)
                return
        elif found.get("deactivated"):
            log.warning("not joining %s: the account is deactivated", user)
            return
        if not synapse.join(room_id, user):
            waiting.add(user)

    def apply(self, channel_set: ChannelSet, *, full: bool = False) -> Applied:
        result = Applied()
        self._accounts_owed(channel_set)
        rooms = self._state.channel_rooms()
        prints = self._state.channel_fingerprints()
        channels = channel_set.channels
        wanted = {c["channel_id"]: self._wanted(c, channel_set.all_members) for c in channels}
        failed: dict[str, None] = {}  # in order, once each

        def fail(channel_id: str) -> None:
            failed.setdefault(channel_id)
            prints.pop(channel_id, None)

        def applied(channel_id: str) -> dict[str, str] | None:
            room_id = rooms.get(channel_id)
            if room_id is None or channel_id not in wanted:
                return None
            return {"room": room_id, "state": wanted[channel_id].digest}

        # Dropped before anything is written: a pass that stops halfway leaves no fingerprint that
        # names state the room may not hold.
        stale = [c for c, value in prints.items() if value != applied(c)]
        for channel_id in stale:
            del prints[channel_id]
        if stale:
            self._state.keep_channel_fingerprints(prints)
        written = dict(prints)
        owed = _Owed(self._state)
        deleted = sorted(set(rooms) - set(wanted))

        def fresh(channel_id: str) -> bool:
            return not full and channel_id in prints

        try:
            synapse = self._synapse
            try:
                keep = {synapse.me()} | (
                    {synapse.room_access_user} if synapse.room_access_user else set()
                )
                seen = self._remove(channels, wanted, rooms, keep, fresh, fail, owed, result)
            except SynapseUnavailableError:
                for channel in channels:
                    fail(channel["channel_id"])
                raise
            for channel_id in deleted:
                try:
                    self._close(rooms[channel_id], keep, result)
                    owed.rooms.discard(rooms.pop(channel_id))
                    prints.pop(channel_id, None)
                except SynapseUnavailableError:
                    for channel in channels:
                        fail(channel["channel_id"])
                    raise
                except EngineError:
                    log.warning(
                        "the room of deleted channel %s was not emptied", channel_id, exc_info=True
                    )
                    # Kept, so the next application tries again; reported as a failure.
                    result.not_closed.append(channel_id)
            for index, channel in enumerate(channels):
                channel_id = channel["channel_id"]
                try:
                    room_id = self._converge(
                        channel,
                        wanted[channel_id],
                        rooms,
                        seen,
                        keep,
                        fresh(channel_id),
                        owed,
                        result,
                    )
                except SynapseUnavailableError:
                    for left in channels[index:]:
                        fail(left["channel_id"])
                    raise
                except EngineError:
                    log.warning("channel %s did not converge", channel_id, exc_info=True)
                    fail(channel_id)
                    continue
                if channel_id not in failed:
                    result.channels_applied += 1
                    prints[channel_id] = {"room": room_id, "state": wanted[channel_id].digest}
        except SynapseUnavailableError as exc:
            result.unavailable = True
            log.warning("synapse did not answer, the pass ends here: %s", exc)
            # Wherever the pass stopped, a deleted channel's room still recorded still holds its
            # members: reported, so the command fails and Core retries it.
            result.not_closed.extend(
                c for c in deleted if c in rooms and c not in result.not_closed
            )
        result.failed = list(failed)
        # A pass that stopped early did not reach every channel: whoever was waiting still is.
        self.waiting = frozenset(
            result.waiting | (self.waiting if result.unavailable else frozenset())
        )
        owed.rooms &= set(rooms.values())  # a room no longer recorded owes nothing
        self._state.keep_channel_rooms(rooms)
        if prints != written:
            self._state.keep_channel_fingerprints(prints)
        owed.save()
        return result

    def signed_in(self) -> bool:
        """Whether someone the last application was waiting for has an account now: they signed in
        to Espace, and applying the set again joins them. One paged admin read; nothing when no one
        is waiting."""
        return bool(self.waiting) and not self.waiting.isdisjoint(self._synapse.active_users())

    def _wanted(self, channel: dict[str, Any], all_members: frozenset[str]) -> _Wanted:
        synapse = self._synapse
        users = frozenset(
            u for s in room_members(channel, all_members) if (u := synapse.user_id(s)) is not None
        )
        exempt = sorted(u for s in channel["exempt"] if (u := synapse.user_id(s)) in users)
        public = native_public(channel, synapse)
        governance = policy(channel, exempt, users)
        if public:
            governance["local_only"] = True
        state = (
            (POLICY, governance),
            (POWER_LEVELS, power_levels(channel, synapse, exempt)),
            ("m.room.name", {"name": channel["name"]}),
            ("m.room.topic", {"topic": channel["topic"]}),
            (JOIN_RULES, {"join_rule": "public" if public else "invite"}),
        )
        digest = hashlib.sha256(json.dumps(state, sort_keys=True).encode()).hexdigest()
        return _Wanted(users, state, digest)

    # -- phase 1: take access away -----------------------------------------------------------

    def _remove(
        self,
        channels: tuple[dict[str, Any], ...],
        wanted: dict[str, _Wanted],
        rooms: dict[str, str],
        keep: set[str],
        fresh: Callable[[str], bool],
        fail: Callable[[str], None],
        owed: _Owed,
        result: Applied,
    ) -> dict[str, set[str]]:
        """Kick, in every recorded room, whoever its channel no longer holds, then end the calls
        owed. Returns room id → who the room holds now, for the rooms whose membership was read."""
        tasks = [c for c in channels if c["channel_id"] in rooms]
        seen: dict[str, set[str]] = {}
        removed: dict[str, list[str]] = {}
        if not tasks:
            return seen
        stop = threading.Event()
        unavailable: SynapseUnavailableError | None = None
        with ThreadPoolExecutor(max_workers=min(self._workers, len(tasks))) as pool:
            futures = [
                (
                    channel,
                    pool.submit(
                        self._clear,
                        channel,
                        rooms[channel["channel_id"]],
                        wanted[channel["channel_id"]],
                        keep,
                        not fresh(channel["channel_id"]),
                        stop,
                    ),
                )
                for channel in tasks
            ]
            for channel, future in futures:
                room_id = rooms[channel["channel_id"]]
                try:
                    seen[room_id], removed[room_id] = future.result()
                except SynapseUnavailableError as exc:
                    unavailable = unavailable or exc
                except EngineError:
                    log.warning(
                        "the removals of channel %s did not converge",
                        channel["channel_id"],
                        exc_info=True,
                    )
                    fail(channel["channel_id"])
        if unavailable is not None:
            raise unavailable
        audio = [c for c in tasks if c["kind"] == "audio"]
        # Saved before LiveKit is asked: a call it cannot end now is ended by a later pass. An
        # archived channel's call is checked on every pass anyway, so it is not recorded.
        owed.rooms |= {rooms[c["channel_id"]] for c in audio if removed.get(rooms[c["channel_id"]])}
        owed.save()
        for channel in audio:
            room_id = rooms[channel["channel_id"]]
            if room_id not in owed.rooms and not channel["archived"]:
                continue
            try:
                result.removed_from_calls += self._end_calls(
                    room_id, self._admitted(channel, wanted[channel["channel_id"]]), result
                )
                owed.rooms.discard(room_id)
            except EngineError:
                log.warning("channel %s's call was not ended", channel["channel_id"], exc_info=True)
                fail(channel["channel_id"])
        return seen

    @staticmethod
    def _admitted(channel: dict[str, Any], wanted: _Wanted) -> frozenset[str]:
        """Who may stay in the channel's call: no one once it is archived."""
        return frozenset() if channel["archived"] else wanted.users

    def _clear(
        self,
        channel: dict[str, Any],
        room_id: str,
        wanted: _Wanted,
        keep: set[str],
        unapplied: bool,
        stop: threading.Event,
    ) -> tuple[set[str], list[str]]:
        """One room's removals, on a worker. Touches neither the result nor the agent's state."""
        synapse = self._synapse

        def check() -> None:
            if stop.is_set():
                raise SynapseUnavailableError("synapse did not answer earlier in this pass")

        try:
            if channel["archived"] and unapplied:
                self._put_state(room_id, wanted.closing, check)
            check()
            present = self._present(room_id)
            removed = sorted(present - wanted.users - keep)
            for user in removed:
                check()
                synapse.kick(room_id, user)
        except SynapseUnavailableError:
            stop.set()
            raise
        return present - set(removed), removed

    # -- phase 2: everything else ------------------------------------------------------------

    def _converge(
        self,
        channel: dict[str, Any],
        wanted: _Wanted,
        rooms: dict[str, str],
        seen: dict[str, set[str]],
        keep: set[str],
        fresh: bool,
        owed: _Owed,
        result: Applied,
    ) -> str:
        synapse = self._synapse
        channel_id = channel["channel_id"]
        room_id = rooms.get(channel_id)
        if not fresh or room_id is None:
            room_id = synapse.resolve(channel_id)
            if room_id is not None and rooms.get(channel_id) != room_id:
                # A room the agent has not recorded: converged only if the agent created it.
                if synapse.creator(room_id) != synapse.me():
                    raise EngineError(
                        f"the room under channel {channel_id}'s alias is not the agent's"
                    )
            if room_id is None:
                room_id = synapse.create(
                    channel_id,
                    channel["name"],
                    channel["topic"],
                    [
                        {"type": kind, "state_key": "", "content": content}
                        for kind, content in wanted.state
                        if kind in (POLICY, JOIN_RULES)
                    ],
                    wanted.state[1][1],
                )
            else:
                self._put_state(room_id, wanted.state)
            if rooms.get(channel_id) != room_id:
                # Recorded at once: a deleted channel's room is then emptied even if this pass stops.
                rooms[channel_id] = room_id
                self._state.keep_channel_rooms(rooms)
        present = seen.get(room_id)
        if present is None:
            # Not read by the first phase: a room found or made just now, or one whose removals
            # failed there. Its removals run here.
            present = self._present(room_id)
            removed = sorted(present - wanted.users - keep)
            for user in removed:
                synapse.kick(room_id, user)
            present -= set(removed)
            if channel["kind"] == "audio" and (
                removed or channel["archived"] or room_id in owed.rooms
            ):
                if removed:
                    owed.rooms.add(room_id)
                    owed.save()  # as in the first phase: before LiveKit is asked
                result.removed_from_calls += self._end_calls(
                    room_id, self._admitted(channel, wanted), result
                )
                owed.rooms.discard(room_id)
        if not native_public(channel, synapse):
            for user in sorted(wanted.users - present):
                self._join(room_id, user, result.waiting)
        access = synapse.room_access_user
        # Joined at once, as members are: invited only, room-access would refuse every token for
        # a new audio room until its next pass accepted the invite. Invited when its account does
        # not exist yet, and it accepts on its first pass.
        if channel["kind"] == "audio" and access and access not in present:
            if not synapse.join(room_id, access):
                synapse.invite(room_id, access)
        posted = self._state.posted_notices()
        for notice in channel["notices"]:
            if notice["notice_id"] not in posted:
                synapse.notice(room_id, notice["notice_id"], notice["body"])
                self._state.record_notice(notice["notice_id"])
                result.notices_posted += 1
        return room_id

    def _present(self, room_id: str) -> set[str]:
        """Who the room holds or has invited."""
        membership = self._synapse.members(room_id)
        return {u for u, m in membership.items() if m in ("join", "invite")}

    def _put_state(
        self,
        room_id: str,
        state: Iterable[tuple[str, dict[str, Any]]],
        check: Callable[[], None] = lambda: None,
    ) -> None:
        """Write each state event whose content differs from what the room holds."""
        synapse = self._synapse
        for event_type, desired in state:
            check()
            current = synapse.state(room_id, event_type)
            if current is None or any(current.get(k) != v for k, v in desired.items()):
                check()
                synapse.put_state(room_id, event_type, {**(current or {}), **desired})

    def _end_calls(self, room_id: str, admitted: frozenset[str], result: Applied) -> int:
        """Remove from the room's live call everyone whose Matrix user is not `admitted`. LiveKit
        identities are `{user_id}|{device_id}` (room_access), so a member's every device leaves.
        Once LiveKit fails to answer in a pass, later audio channels fail immediately without
        waiting for another timeout."""
        if result.livekit_unavailable:
            raise LiveKitUnavailableError("livekit did not answer earlier in this pass")
        name, removed = livekit_room(room_id), 0
        try:
            for participant in self._livekit.participants(name):
                identity = str(participant.get("identity", ""))
                if identity.split("|", 1)[0] not in admitted:
                    self._livekit.remove(name, identity)
                    removed += 1
        except LiveKitUnavailableError:
            result.livekit_unavailable = True
            raise
        return removed

    def _close(self, room_id: str, keep: set[str], result: Applied) -> None:
        """A deleted channel: archive the room's policy so room-access admits no one, end its call,
        and remove every member."""
        synapse = self._synapse
        current = synapse.state(room_id, POLICY) or {}
        synapse.put_state(room_id, POLICY, {**current, "archived": True})
        synapse.put_state(room_id, JOIN_RULES, {"join_rule": "invite"})
        for user, membership in synapse.members(room_id).items():
            if membership in ("join", "invite") and user not in keep:
                synapse.kick(room_id, user)
        if current.get("kind") == "audio":
            result.removed_from_calls += self._end_calls(room_id, frozenset(), result)
