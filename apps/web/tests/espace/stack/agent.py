#!/usr/bin/env python3
"""Core's real tenant agent, driven by hand against this stack (docs/dev/ESPACE_STACK.md).

A thin harness, not a re-implementation: each command is handed to Core's
`tenant_agent.handlers.Handlers.handle`, from the checkout `CORE_SRC` names, as the agent's command
loop hands it a command from Core. Every room, power level, membership and deactivation is made by
that code. Only the command loop is left out (no Core API here), and Docs and Meet, which this
stack does not run, are stubs that converge nothing and know no deactivated user.

    agent.py apply <channel-set.json>   engine_set_channel_members, the file as its payload
    agent.py members <subject>...       engine_set_member_subjects: these subjects are active,
                                        every subject known before and not named is inactive,
                                        and each one named that was inactive is released
                                        (reactivated), as Core sends it (ADR-0016)
    agent.py deactivate <subject>       the same, with one active subject made inactive

Each prints the handler's outcome as JSON (`status`, `error_code`, `detail`, `artefacts`), with
`revision`; `apply` adds the rooms the agent holds and what Core's channel pass reported
(`channels_applied`, `failed`, `waiting`, `removed_from_calls`, ...). It exits 1 when the outcome
is not `succeeded`. Configuration comes from `.runtime/config` (written by bin/up.sh), overridden by the
environment: CORE_SRC, AGENT_MATRIX_TOKEN, AGENT_STATE_DIR. Run it with a Python that has Core's
one dependency outside the standard library (PyJWT); closure.mjs makes that venv.
"""

import json
import os
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
SERVER_NAME = "kodera.test"
# Core's and Fleet's name for room-access's account (Core docs/specs/ESPACE_STRUCTURE.md).
ROOM_ACCESS_USER = f"@kodera-rooms:{SERVER_NAME}"


def settings() -> dict[str, str]:
    values: dict[str, str] = {}
    env_file = HERE / ".runtime" / "config"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                name, _, value = line.partition("=")
                values[name] = value
    values["CORE_SRC"] = str(HERE.parents[3] / "server")
    values.update({k: v for k, v in os.environ.items() if v})
    return values


CONFIG = settings()
if not CONFIG.get("CORE_SRC"):
    sys.exit("agent.py: CORE_SRC must name a Core checkout")
sys.path.insert(0, str(Path(CONFIG["CORE_SRC"]).resolve()))

from tenant_agent.channels import CHANNEL_KIND, Applied, Channels  # noqa: E402 - after CORE_SRC
from tenant_agent.engines import LiveKit  # noqa: E402
from tenant_agent.guard import RosterGuard  # noqa: E402
from tenant_agent.handlers import MEMBER_KIND, Handlers  # noqa: E402
from tenant_agent.state import State  # noqa: E402
from tenant_agent.synapse import Synapse  # noqa: E402


class NoDocs:
    """Docs does not run in this stack: it has no account to converge."""

    def converge(self, inactive: list[str], released: list[str], *, full: bool) -> dict[str, int]:
        return {}


class NoMeet(NoDocs):
    """Meet does not run in this stack: it has no account to converge, nor a deactivated user."""

    def deactivated(self, identities: list[str]) -> set[str]:
        return set()


class Observed(Channels):
    """Core's Channels, unchanged; it keeps what its last pass reported, which the handler's
    outcome summarises, so the harness can print the detail (members waiting, calls ended)."""

    last: Applied | None = None

    # Whatever Core's `apply` takes (`full=` since its removals-first pass) passes through.
    def apply(self, channel_set: Any, *args: Any, **kwargs: Any) -> Applied:
        self.last = super().apply(channel_set, *args, **kwargs)
        return self.last


def build() -> tuple[Handlers, Observed, State]:
    synapse = Synapse(
        f"http://127.0.0.1:{CONFIG['SYNAPSE_PORT']}",
        CONFIG["AGENT_MATRIX_TOKEN"],
        SERVER_NAME,
        room_access_user=ROOM_ACCESS_USER,
    )
    livekit = LiveKit(
        f"http://127.0.0.1:{CONFIG['LIVEKIT_PORT']}",
        CONFIG["LIVEKIT_API_KEY"],
        CONFIG["LIVEKIT_API_SECRET"],
    )
    state = State(Path(CONFIG.get("AGENT_STATE_DIR") or HERE / ".agent-state"))
    meet = NoMeet()
    guard = RosterGuard(livekit, meet, state, synapse)  # type: ignore[arg-type] - a stub Meet
    channels = Observed(synapse, livekit, state)
    handlers = Handlers(NoDocs(), meet, guard, state, synapse, channels)  # type: ignore[arg-type]
    return handlers, channels, state


def apply(path: str) -> dict[str, Any]:
    handlers, channels, state = build()
    payload = json.loads(Path(path).read_text())
    outcome = handlers.handle(CHANNEL_KIND, payload).as_dict()
    stored = state.channel_set()
    applied = asdict(channels.last) if channels.last is not None else {}
    return {
        **outcome,
        **applied,
        "revision": stored.get("revision") if stored else None,
        "rooms": state.channel_rooms(),
    }


def member_set(active: set[str], also_inactive: frozenset[str] = frozenset()) -> dict[str, Any]:
    """The next `engine_set_member_subjects` payload, as Core sends it, handed to the handler.
    A subject the set in force lists as inactive and this one names active is released: Core's
    "once listed as inactive, active again" (ADR-0016), the path that lifts a suspension."""
    handlers, _, state = build()
    current = state.member_set()
    known = (current.active | current.inactive) if current else frozenset()
    released = (current.inactive & active) if current else frozenset()
    revision = current.revision + 1 if current else 1
    payload = {
        "revision": revision,
        "active_subjects": sorted(active),
        "inactive_subjects": sorted((known | also_inactive) - active),
        "released_subjects": sorted(released),
        "erased_subjects": [],
    }
    outcome = handlers.handle(MEMBER_KIND, payload).as_dict()
    in_force = state.member_set()
    return {**outcome, "revision": in_force.revision if in_force else None}


def _listed(value: object) -> list[object]:
    if isinstance(value, (set, frozenset)):
        return sorted(value, key=str)
    raise TypeError(f"{type(value).__name__} is not JSON serializable")


def main(argv: list[str]) -> int:
    command, args = (argv[1], argv[2:]) if len(argv) > 1 else ("", [])
    if command == "apply" and len(args) == 1:
        result = apply(args[0])
    elif command == "members" and args:
        result = member_set(set(args))
    elif command == "deactivate" and len(args) == 1:
        current = State(Path(CONFIG.get("AGENT_STATE_DIR") or HERE / ".agent-state")).member_set()
        active = set(current.active if current else ()) - {args[0]}
        result = member_set(active, frozenset({args[0]}))
    else:
        print(__doc__, file=sys.stderr)
        return 2
    # Core's handlers may answer with sets (an outcome's ids); JSON has lists, in a stable order.
    print(json.dumps(result, indent=2, sort_keys=True, default=_listed))
    return 0 if result["status"] == "succeeded" else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
