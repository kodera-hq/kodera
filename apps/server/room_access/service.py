"""What room-access decides (ADR-0018): who gets a token, who stays in a call, and who is shown in it.

- **Rate.** A caller's identity is the Matrix user its own token names; the listener counts each
  identity's token requests through `admit`, before the room or LiveKit is asked anything.
- **Token.** Only for an audio channel's room that is not archived, only to a joined member, for
  that room only. Publishing is withheld in a listen-only room from members outside `may_publish`.
  The identity is the caller's Matrix user and device, read from their own token.
- **Policy.** A room's `io.kodera.room.policy` counts only when the agent sent it: in a direct
  message a member holds every power level and could write one. Token and guard read it alike.
- **Invitations.** Only the agent's are accepted; any other is declined.
- **Guard.** On every `participant_joined` and every reconciliation pass: a participant whose user
  is not joined to the room, or who is in an archived room, is removed. A participant whose publish
  right no longer matches the policy (listen-only switched during the call) is updated.
- **Occupancy.** Who is in the room, on how many devices, sharing a screen or a camera, written as
  `io.kodera.room.occupancy` when it changes. After a restart, the first pass compares with the
  event already in the room, so an unchanged call writes nothing.
"""

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, TypeGuard

from .clients import LiveKit, Matrix, UpstreamError
from .rooms import OCCUPANCY, POLICY, identity, livekit_room, user_of

log = logging.getLogger("room_access")
SCREEN_SHARE, CAMERA = ("SCREEN_SHARE", 3), ("CAMERA", 1)


@dataclass(frozen=True)
class Grant:
    url: str
    token: str
    listen_only: bool


class RefusedError(Exception):
    def __init__(self, status: int) -> None:
        super().__init__(status)
        self.status = status


class RateLimitedError(Exception):
    """The caller's identity has spent its token requests for now: `429`, after `retry_after_s`."""

    def __init__(self, retry_after_s: int) -> None:
        super().__init__(retry_after_s)
        self.retry_after_s = retry_after_s


def _publishes(participant: dict[str, Any]) -> bool:
    return bool(participant.get("tracks"))


def _source(track: dict[str, Any]) -> Any:
    return track.get("source")


def _active_audio_policy(policy: dict[str, Any] | None) -> TypeGuard[dict[str, Any]]:
    """A missing, retired or malformed policy cannot admit or retain a media participant."""
    return (
        isinstance(policy, dict)
        and type(policy.get("version")) is int
        and policy["version"] == 1
        and policy.get("kind") == "audio"
        and policy.get("archived") is False
        and type(policy.get("listen_only")) is bool
        and isinstance(policy.get("may_publish"), list)
        and all(isinstance(user, str) for user in policy["may_publish"])
    )


@dataclass
class Stats:
    passes: int = 0
    removed: int = 0
    updated: int = 0
    writes: int = 0
    pass_ms_max: float = 0.0


@dataclass
class Service:
    matrix: Matrix
    livekit: LiveKit
    ws_url: str
    agent: str  # the tenant agent's Matrix account: the only sender of a policy that counts
    token_ttl_s: int = 600
    stats: Stats = field(default_factory=Stats)
    _rooms: dict[str, str] = field(default_factory=dict)  # LiveKit room → Matrix room
    _published: dict[str, Any] = field(default_factory=dict)  # LiveKit room → occupancy written
    _locks: dict[str, threading.Lock] = field(default_factory=dict)
    # LiveKit room → (identity → the publish right that participant holds, as last set or seen).
    _rights: dict[str, dict[str, bool]] = field(default_factory=dict)
    _guard: threading.Lock = field(default_factory=threading.Lock)

    def _policy(self, room_id: str) -> dict[str, Any] | None:
        """The room's policy content, or None unless the agent sent it."""
        event = self.matrix.state_event(room_id, POLICY)
        if not isinstance(event, dict) or event.get("sender") != self.agent:
            return None
        content = event.get("content")
        return content if isinstance(content, dict) else None

    # -- the token ---------------------------------------------------------------------------

    def grant(
        self, matrix_token: str, room_id: Any, *, admit: Callable[[str], None] | None = None
    ) -> Grant:
        """`admit` is called with the caller's Matrix user once Synapse has named it, before the
        room is read and before LiveKit is asked anything; it raises to refuse (the listener's
        per-identity rate limit)."""
        if not isinstance(room_id, str) or not room_id.startswith("!") or len(room_id) > 255:
            raise RefusedError(400)
        if (
            not isinstance(matrix_token, str)
            or not matrix_token
            or any(c.isspace() or ord(c) < 0x21 or ord(c) > 0x7E for c in matrix_token)
        ):
            raise RefusedError(401)
        caller = self.matrix.whoami(matrix_token)
        if caller is None:
            raise RefusedError(401)
        user_id, device_id = caller
        if admit is not None:
            admit(user_id)
        policy = self._policy(room_id)
        # One answer for "no such room", "not an audio room", "archived" and "not a member".
        if not _active_audio_policy(policy) or self.matrix.membership(room_id, user_id) != "join":
            raise RefusedError(403)
        name = livekit_room(room_id)
        # Idempotent, and needed each time: LiveKit closes an empty room after its timeout.
        self.livekit.create_room(name, room_id)
        with self._guard:
            self._rooms[name] = room_id
        listen_only = bool(policy.get("listen_only")) and user_id not in policy.get(
            "may_publish", []
        )
        token = self.livekit.token(
            name, identity(user_id, device_id), can_publish=not listen_only, ttl_s=self.token_ttl_s
        )
        return Grant(self.ws_url, token, listen_only)

    # -- guard and occupancy -----------------------------------------------------------------

    def _lock(self, name: str) -> threading.Lock:
        with self._guard:
            return self._locks.setdefault(name, threading.Lock())

    def refresh(self, name: str, room_id: str | None = None) -> None:
        with self._guard:
            if room_id is None:
                room_id = self._rooms.get(name)
            else:
                self._rooms[name] = room_id
            lock = self._locks.setdefault(name, threading.Lock())
            rights = self._rights.setdefault(name, {})
        if room_id is None:
            return
        with lock:
            participants = self.livekit.participants(name)
            policy = self._policy(room_id) or {}
            active_audio = _active_audio_policy(policy)
            # Invalidated policy is enough to remove everyone, even if membership is unreadable.
            joined = self.matrix.joined_members(room_id) if participants and active_audio else set()
            may_publish = set(policy["may_publish"]) if active_audio else set()
            seen: dict[str, dict[str, Any]] = {}
            removed = updated = 0
            for participant in participants:
                who = str(participant.get("identity", ""))
                user = user_of(who)
                if not active_audio or user not in joined:
                    self.livekit.remove(name, who)
                    removed += 1
                    continue
                allowed = not policy.get("listen_only") or user in may_publish
                permission = participant.get("permission") or {}
                if who not in rights:
                    # First sight (or after a restart): what LiveKit says, else what the token
                    # was minted with under the policy then, which is the policy now.
                    # LiveKit's Twirp JSON answers in proto field names (`can_publish`).
                    rights[who] = bool(
                        permission.get("can_publish", permission.get("canPublish", allowed))
                    )
                if rights[who] != allowed or (not allowed and _publishes(participant)):
                    self.livekit.set_publish(name, who, allowed)
                    rights[who] = allowed
                    updated += 1
                entry = seen.setdefault(
                    user, {"user_id": user, "devices": 0, "screen_share": False, "camera": False}
                )
                entry["devices"] += 1
                for track in participant.get("tracks", []):
                    entry["screen_share"] |= _source(track) in SCREEN_SHARE
                    entry["camera"] |= _source(track) in CAMERA
            present = {str(p.get("identity", "")) for p in participants}
            for who in [k for k in rights if k not in present]:
                del rights[who]
            if removed or updated:
                with self._guard:
                    self.stats.removed += removed
                    self.stats.updated += updated
            occupancy = [seen[u] for u in sorted(seen)]
            self._publish(name, room_id, occupancy)

    def _publish(self, name: str, room_id: str, occupancy: list[dict[str, Any]]) -> None:
        with self._guard:
            known = name in self._published
            previous = self._published.get(name)
        if not known:
            # After a restart: compare with what the room already shows.
            current = self.matrix.state(room_id, OCCUPANCY)
            previous = current.get("participants") if current else None
            with self._guard:
                self._published[name] = previous
        if previous == occupancy or (previous is None and not occupancy):
            return
        self.matrix.put_state(
            room_id,
            OCCUPANCY,
            {"version": 1, "participants": occupancy, "at_ms": int(time.time() * 1000)},
        )
        with self._guard:
            self._published[name] = occupancy
            self.stats.writes += 1

    def reconcile_once(self) -> None:
        started = time.monotonic()
        try:
            for room_id in self.matrix.accept_invites(self.agent):
                log.info("joined audio room %s", room_id)
            names = set()
            for room in self.livekit.rooms():
                name, room_id = str(room.get("name", "")), str(room.get("metadata", ""))
                if (
                    name.startswith("kodera-")
                    and room_id.startswith("!")
                    and livekit_room(room_id) == name
                ):
                    names.add(name)
                    self._guarded(name, room_id)
            # A room LiveKit closed: whoever it showed has left.
            with self._guard:
                published = list(self._published.items())
            for name, shown in published:
                if shown and name not in names:
                    self._guarded(name, None)
        except UpstreamError:
            log.warning("reconciliation pass failed; the next one retries", exc_info=True)
        elapsed_ms = (time.monotonic() - started) * 1000
        with self._guard:
            self.stats.passes += 1
            self.stats.pass_ms_max = max(self.stats.pass_ms_max, elapsed_ms)

    def _guarded(self, name: str, room_id: str | None) -> None:
        try:
            self.refresh(name, room_id)
        except UpstreamError:
            log.warning("room %s not reconciled", name, exc_info=True)

    def on_webhook(self, event: dict[str, Any]) -> None:
        room = event.get("room") or {}
        name, room_id = str(room.get("name", "")), str(room.get("metadata", ""))
        if not name.startswith("kodera-"):
            return  # a Meet room: the tenant agent's guard
        self._guarded(
            name, room_id if room_id.startswith("!") and livekit_room(room_id) == name else None
        )
