"""The LiveKit roster guard (ADR-0016, extended by ADR-0018).

A LiveKit grant is a bearer token valid for hours, and deactivating a member does not end the call
they are in. The guard removes from every room each participant whose subject is inactive in the
member set in force, and each one Meet knows as a deactivated user. Room-level access (roles, the
lobby, moderation) stays Meet's: a participant Meet admitted is never second-guessed, and anonymous
guests are Meet's to admit.

An Espace audio room (`kodera-…`, ADR-0018) is checked against the channel set in force instead:
anyone whose Matrix user is not a member of the room's channel, or whose subject is inactive, is
removed, and Meet is not asked. The room-access service runs the same check on every
reconciliation pass; this guard is its 5-minute and on-webhook backstop.

One room's failure does not stop the others: it is counted and logged, and the next run retries it.
"""

import logging
from dataclasses import dataclass, field

from .channels import room_members
from .docker_exec import ExecError
from .engines import EngineError, LiveKit, LiveKitUnavailableError, Meet
from .state import State
from .synapse import Synapse, livekit_room

log = logging.getLogger("tenant_agent.guard")


@dataclass
class GuardReport:
    rooms: int = 0
    removed: list[tuple[str, str]] = field(default_factory=list)
    failed_rooms: int = 0


class RosterGuard:
    def __init__(
        self, livekit: LiveKit, meet: Meet | None, state: State, synapse: Synapse | None = None
    ) -> None:
        self._livekit, self._meet, self._state, self._synapse = livekit, meet, state, synapse

    def enforce(self, room: str | None = None) -> GuardReport:
        report = GuardReport()
        current = self._state.member_set()
        inactive = current.inactive if current else frozenset()
        audio = self._audio_members()
        names = [room] if room else self._livekit.rooms()
        for index, name in enumerate(names):
            report.rooms += 1
            try:
                identities = [str(p["identity"]) for p in self._livekit.participants(name)]
                if not identities:
                    continue
                if name.startswith("kodera-"):
                    allowed = audio.get(name, frozenset())
                    for identity in identities:
                        user = identity.split("|", 1)[0]
                        if user not in allowed or user.split(":")[0][1:] in inactive:
                            self._livekit.remove(name, identity)
                            report.removed.append((name, identity))
                    continue
                refused = set(inactive)
                if self._meet is not None:
                    refused |= self._meet.deactivated(identities)
                for identity in identities:
                    if identity in refused:
                        self._livekit.remove(name, identity)
                        report.removed.append((name, identity))
            except LiveKitUnavailableError:
                report.failed_rooms += len(names) - index
                report.rooms += len(names) - index - 1
                log.warning(
                    "livekit did not answer, roster guard stops at room %s", name, exc_info=True
                )
                break
            except (EngineError, ExecError):
                report.failed_rooms += 1
                log.warning("roster guard could not check room %s", name, exc_info=True)
        return report

    def _audio_members(self) -> dict[str, frozenset[str]]:
        """LiveKit room → the Matrix users the channel set in force admits to its call."""
        if self._synapse is None:
            return {}
        stored, rooms = self._state.channel_set(), self._state.channel_rooms()
        found: dict[str, frozenset[str]] = {}
        for channel in (stored or {}).get("channels", []):
            room_id = rooms.get(channel["channel_id"])
            if channel["kind"] != "audio" or room_id is None or channel["archived"]:
                continue
            everyone = frozenset((stored or {}).get("all_members", []))
            users = (self._synapse.user_id(s) for s in room_members(channel, everyone))
            found[livekit_room(room_id)] = frozenset(u for u in users if u is not None)
        return found
