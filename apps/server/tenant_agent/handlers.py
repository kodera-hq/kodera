"""`engine_set_member_subjects` (ADR-0016): converge every engine of the VM to the member set.

Applying a set twice changes nothing, so a set is applied whole every time: when it arrives, every
15 minutes, and after a restore. A set with a lower revision than the one in force is not applied.
"""

import logging
import re
from dataclasses import dataclass
from typing import Any

from .channels import CHANNEL_KIND, Channels, parse as parse_channels
from .docker_exec import ExecError
from .engines import Docs, EngineError, Meet
from .guard import RosterGuard
from .state import MemberSet, State
from .synapse import Synapse

log = logging.getLogger("tenant_agent")
MEMBER_KIND = "engine_set_member_subjects"
_SUBJECT = re.compile(r"[\x21-\x7e]{1,255}")
MAX_SUBJECTS = 10_000


@dataclass(frozen=True)
class Outcome:
    status: str  # succeeded | failed
    error_code: str | None = None
    detail: str | None = None
    artefacts: dict[str, Any] | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "error_code": self.error_code,
            "detail": self.detail,
            "artefacts": self.artefacts,
        }


def _failed(code: str, detail: str) -> Outcome:
    return Outcome("failed", code, detail[:2000])


def _subjects(payload: dict[str, Any], name: str) -> frozenset[str] | None:
    value = payload.get(name)
    if not isinstance(value, list):
        return None
    if not all(isinstance(s, str) and _SUBJECT.fullmatch(s) for s in value):
        return None
    return frozenset(value)


def parse(payload: dict[str, Any]) -> MemberSet | None:
    revision = payload.get("revision")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        return None
    active = _subjects(payload, "active_subjects")
    inactive = _subjects(payload, "inactive_subjects")
    released = _subjects(payload, "released_subjects")
    erased = _subjects(payload, "erased_subjects") if "erased_subjects" in payload else frozenset()
    if active is None or inactive is None or released is None or erased is None:
        return None
    if len(active) + len(inactive) + len(released) + len(erased) > MAX_SUBJECTS:
        return None
    if active & inactive or not erased <= inactive:
        return None
    return MemberSet(revision, active, inactive, released, erased)


class Handlers:
    def __init__(
        self,
        docs: Docs | None,
        meet: Meet | None,
        guard: RosterGuard,
        state: State,
        synapse: Synapse | None = None,
        channels: Channels | None = None,
    ) -> None:
        self._docs, self._meet, self._guard, self._state = docs, meet, guard, state
        self._synapse, self._channels = synapse, channels

    @property
    def kinds(self) -> tuple[str, ...]:
        return (MEMBER_KIND, CHANNEL_KIND) if self._channels is not None else (MEMBER_KIND,)

    def handle(self, kind: str, payload: dict[str, Any]) -> Outcome:
        if kind not in self.kinds:
            return _failed("unsupported_kind", f"this agent does not implement {kind}")
        if kind == CHANNEL_KIND:
            return self.handle_channels(payload)
        candidate = parse(payload)
        if candidate is None:
            return _failed("invalid_payload", "the member set is missing, malformed or too large")
        try:
            in_force = self._state.keep(candidate)
            return self.apply(in_force, received=True)
        except Exception:  # noqa: BLE001 - reported as internal_error, never a crash
            log.exception("applying revision %s failed", candidate.revision)
            return _failed("internal_error", "the agent failed unexpectedly; see the agent log")

    def apply(self, member_set: MemberSet, *, received: bool) -> Outcome:
        """Converge each engine on its own, then guard LiveKit: one engine's failure stops
        neither the others nor the guard. A received set also reactivates, and re-runs the
        follow-up steps for every inactive user; the periodic re-application only deactivates."""
        inactive = sorted(member_set.inactive)
        released = sorted(member_set.released) if received else []
        counts = {"deactivated": 0, "reactivated": 0, "documents_kicked": 0, "erased": 0}
        failed = []
        engines: list[tuple[str, Any]] = [
            (name, engine)
            for name, engine in (("docs", self._docs), ("meet", self._meet))
            if engine is not None  # an app this tenant does not run
        ]
        if self._synapse is not None:
            engines.append(("synapse", self._synapse))
        for name, engine in engines:
            try:
                if name == "synapse":
                    answer = engine.converge(
                        inactive,
                        released,
                        full=received,
                        erased=sorted(member_set.erased),
                        done=self._state,
                    )
                else:
                    answer = engine.converge(inactive, released, full=received)
            except (EngineError, ExecError):
                # The engine's own output stays in the VM's log; Core gets the code only.
                log.warning(
                    "converging %s to revision %s failed", name, member_set.revision, exc_info=True
                )
                failed.append(name)
                continue
            for key in counts:
                counts[key] += int(answer.get(key, 0))
        guard = self._guard.enforce()
        if guard.failed_rooms:
            failed.append(f"{guard.failed_rooms} room(s)")
        if failed:
            return _failed(
                "service_unhealthy", f"not converged: {', '.join(failed)}; see the agent log"
            )
        return Outcome(
            "succeeded",
            artefacts={
                "revision_applied": member_set.revision,
                "users_deactivated": counts["deactivated"],
                "users_reactivated": counts["reactivated"],
                "documents_kicked": counts["documents_kicked"],
                "participants_removed": len(guard.removed),
                **({"users_erased": counts["erased"]} if self._synapse is not None else {}),
            },
        )

    def handle_channels(self, payload: dict[str, Any]) -> Outcome:
        candidate = parse_channels(payload)
        if candidate is None or self._channels is None:
            return _failed("invalid_payload", "the channel set is missing, malformed or too large")
        try:
            in_force = self._state.keep_channel_set(
                candidate.revision, list(candidate.channels), sorted(candidate.all_members)
            )
            return self.apply_channels(in_force)
        except Exception:  # noqa: BLE001 - reported as internal_error, never a crash
            log.exception("applying channel set %s failed", candidate.revision)
            return _failed("internal_error", "the agent failed unexpectedly; see the agent log")

    def apply_channels(self, in_force: dict[str, Any], *, full: bool = False) -> Outcome:
        """A received set skips the room state of every channel unchanged since it was last applied
        (`Channels.apply`); the periodic re-application is `full`, and re-reads all of it."""
        channel_set = parse_channels(in_force)
        if channel_set is None or self._channels is None:
            return _failed("internal_error", "the stored channel set is unreadable")
        applied = self._channels.apply(channel_set, full=full)
        artefacts: dict[str, Any] = {
            "revision_applied": channel_set.revision,
            "channels_applied": applied.channels_applied,
            "notices_posted": applied.notices_posted,
        }
        if applied.failed or applied.not_closed or applied.unavailable:
            # A deleted channel is not in the set, so it is never named in `failed_channel_ids`:
            # its room still holding members fails the command, every listed channel that did
            # converge stays reported ready, and Core's retry empties it.
            problems = [
                *(["synapse did not answer"] if applied.unavailable else []),
                *([f"{len(applied.failed)} channel(s) not converged"] if applied.failed else []),
                *(
                    [f"{len(applied.not_closed)} deleted channel room(s) not emptied"]
                    if applied.not_closed
                    else []
                ),
            ]
            return Outcome(
                "failed",
                "service_unhealthy",
                f"{'; '.join(problems)}; see the agent log",
                {**artefacts, "failed_channel_ids": sorted(applied.failed)},
            )
        return Outcome("succeeded", artefacts=artefacts)

    @property
    def waiting(self) -> bool:
        """Whether a member of a channel is still waiting for their first sign-in to Espace."""
        return self._channels is not None and bool(self._channels.waiting)

    def join_waiting(self) -> bool:
        """Apply the channel set in force again as soon as a member it was waiting for has signed
        in, so their channels open within seconds rather than at the 15-minute re-application.
        Not `full`: unchanged rooms get only their membership check. Whether it applied."""
        stored = self._state.channel_set()
        if stored is None or self._channels is None or not self._channels.signed_in():
            return False
        outcome = self.apply_channels(stored)
        log.info("joined members who signed in to Espace: %s", outcome.status)
        return True

    def reapply(self) -> Outcome | None:
        """The 15-minute (and after-restore) re-application of the set in force, if any.

        It deactivates again; it never reactivates. Reactivation happens once, when a set naming
        the subject as released arrives, so an engine administrator's later decision stands. The
        member set comes first: offboarding never waits on the channels' rooms."""
        outcome: Outcome | None = None
        current = self._state.member_set()
        if current is not None:
            try:
                outcome = self.apply(current, received=False)
            except Exception:  # noqa: BLE001 - as in handle
                log.exception("re-applying revision %s failed", current.revision)
                outcome = _failed(
                    "internal_error", "the agent failed unexpectedly; see the agent log"
                )
        stored = self._state.channel_set()
        if stored is not None and self._channels is not None:
            try:
                self.apply_channels(stored, full=True)
            except Exception:  # noqa: BLE001 - as in handle
                log.exception("re-applying channel set %s failed", stored.get("revision"))
        return outcome
