"""The agent's local state on the VM: the command ledger (a command delivered twice is executed
once, its stored result is replayed) and the latest member set applied."""

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


def _write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value))
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)  # atomic: a crash leaves the old file or the new one


@dataclass(frozen=True)
class MemberSet:
    revision: int
    active: frozenset[str]
    inactive: frozenset[str]
    released: frozenset[str]
    erased: frozenset[str] = frozenset()  # inactive subjects of erased people (ADR-0018)


class State:
    def __init__(self, directory: Path) -> None:
        self._dir = directory

    def _ledger(self, command_id: str) -> Path:
        if not command_id.replace("-", "").isalnum():
            raise ValueError("command_id is not an id")
        return self._dir / "ledger" / f"{command_id}.json"

    def result(self, command_id: str) -> dict[str, Any] | None:
        path = self._ledger(command_id)
        if not path.exists():
            return None
        value: dict[str, Any] = json.loads(path.read_text())
        return value

    def record(self, command_id: str, result: dict[str, Any]) -> None:
        _write(self._ledger(command_id), result)

    def prune(self, older_than_s: float = 30 * 24 * 3600) -> int:
        """Forget ledger entries past any redelivery: Core's commands expire within 30 days."""
        ledger = self._dir / "ledger"
        if not ledger.exists():
            return 0
        cutoff, pruned = time.time() - older_than_s, 0
        for entry in ledger.glob("*.json"):
            if entry.stat().st_mtime < cutoff:
                entry.unlink()
                pruned += 1
        return pruned

    def member_set(self) -> MemberSet | None:
        path = self._dir / "member_set.json"
        if not path.exists():
            return None
        value = json.loads(path.read_text())
        return MemberSet(
            int(value["revision"]),
            frozenset(value["active"]),
            frozenset(value["inactive"]),
            frozenset(value["released"]),
            frozenset(value.get("erased", [])),
        )

    def keep(self, candidate: MemberSet) -> MemberSet:
        """Store `candidate` unless a higher revision is stored; return the set now in force."""
        current = self.member_set()
        if current is not None and current.revision > candidate.revision:
            return current
        _write(
            self._dir / "member_set.json",
            {
                "revision": candidate.revision,
                "active": sorted(candidate.active),
                "inactive": sorted(candidate.inactive),
                "released": sorted(candidate.released),
                "erased": sorted(candidate.erased),
            },
        )
        return candidate

    # -- the channel set (ADR-0018) ----------------------------------------------------------

    def channel_set(self) -> dict[str, Any] | None:
        path = self._dir / "channel_set.json"
        if not path.exists():
            return None
        value: dict[str, Any] = json.loads(path.read_text())
        return value

    def keep_channel_set(
        self,
        revision: int,
        channels: list[dict[str, Any]],
        all_members: list[str],
        moderation: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Store this set unless a higher revision is stored; return the set now in force."""
        current = self.channel_set()
        if current is not None and int(current["revision"]) > revision:
            return current
        if current is not None and "banned_subjects" in current and moderation is None:
            raise ValueError("moderation projection cannot be silently dropped")
        value = {
            "revision": revision,
            "all_members": all_members,
            "channels": channels,
            **(moderation or {}),
        }
        _write(self._dir / "channel_set.json", value)
        return value

    def channel_rooms(self) -> dict[str, str]:
        """channel id → the Matrix room the agent made for it."""
        path = self._dir / "channel_rooms.json"
        rooms: dict[str, str] = json.loads(path.read_text()) if path.exists() else {}
        return rooms

    def keep_channel_rooms(self, rooms: dict[str, str]) -> None:
        _write(self._dir / "channel_rooms.json", rooms)

    def channel_fingerprints(self) -> dict[str, dict[str, str]]:
        """channel id → {"room": room id, "state": digest} of the room state last applied whole."""
        path = self._dir / "channel_fingerprints.json"
        prints: dict[str, dict[str, str]] = json.loads(path.read_text()) if path.exists() else {}
        return prints

    def keep_channel_fingerprints(self, prints: dict[str, dict[str, str]]) -> None:
        _write(self._dir / "channel_fingerprints.json", prints)

    def calls_owed(self) -> set[str]:
        """Audio rooms whose call still holds someone the agent removed: checked again each pass
        until LiveKit has answered for them."""
        path = self._dir / "calls_owed.json"
        return set(json.loads(path.read_text())) if path.exists() else set()

    def keep_calls_owed(self, rooms: set[str]) -> None:
        _write(self._dir / "calls_owed.json", sorted(rooms))

    def posted_notices(self) -> set[str]:
        path = self._dir / "notices.json"
        return set(json.loads(path.read_text())) if path.exists() else set()

    def record_notice(self, notice_id: str) -> None:
        """Recorded right after the notice is sent: a crash between the two resends it once, and
        Synapse drops that resend because the transaction id is the notice id."""
        _write(self._dir / "notices.json", sorted(self.posted_notices() | {notice_id}))

    # -- erased messaging accounts (ADR-0018) ------------------------------------------------

    def erased_accounts(self) -> set[str]:
        path = self._dir / "erased.json"
        return set(json.loads(path.read_text())) if path.exists() else set()

    def record_erased(self, user_id: str) -> None:
        """An erasure is final: recorded once done, never asked of Synapse again."""
        _write(self._dir / "erased.json", sorted(self.erased_accounts() | {user_id}))
