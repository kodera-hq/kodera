"""The command loop: fetch, ack, apply, record, report (Agent API, "The loop")."""

import logging
import re
from datetime import UTC, datetime
from typing import Any

from .core_api import CommandGoneError, CoreApi
from .handlers import Handlers, Outcome
from .state import State

log = logging.getLogger("tenant_agent")
_COMMAND_ID = re.compile(r"[0-9a-fA-F-]{36}")


def _expired(command: dict[str, Any]) -> bool:
    """Fail closed: a command whose expiry is missing or unreadable is treated as expired."""
    try:
        expires = datetime.fromisoformat(str(command["expires_at"]).replace("Z", "+00:00"))
    except (KeyError, ValueError):
        return True
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=UTC)
    return expires <= datetime.now(UTC)


class Agent:
    def __init__(self, api: CoreApi, handlers: Handlers, state: State) -> None:
        self._api, self._handlers, self._state = api, handlers, state

    def reapply(self) -> Outcome | None:
        outcome = self._handlers.reapply()
        if outcome is not None:
            log.info("re-applied the member set in force: %s", outcome.status)
        return outcome

    @property
    def waiting(self) -> bool:
        return self._handlers.waiting

    def join_waiting(self) -> bool:
        return self._handlers.join_waiting()

    def poll_once(self, wait_s: int = 0) -> int:
        """Process every command Core returns now. Returns how many were reported."""
        reported = 0
        for command in self._api.commands(self._handlers.kinds, wait_s):
            command_id = str(command.get("command_id", ""))
            if not _COMMAND_ID.fullmatch(command_id):
                log.warning("ignored a command without a well-formed command_id")
                continue
            stored = self._state.result(command_id)
            if stored is not None:
                # Delivered again: replay the stored result, never act twice.
                try:
                    self._api.result(command_id, stored)
                except CommandGoneError:
                    log.info("command %s already has a terminal result", command_id)
                reported += 1
                continue
            try:
                ack = self._api.ack(command_id)
            except CommandGoneError:
                log.info("command %s is already terminal, cancelled or expired", command_id)
                continue
            if ack.get("cancelled"):
                continue
            payload = command.get("payload")
            if _expired(command):
                outcome = Outcome("failed", "expired", "expired before it started")
            elif not isinstance(payload, dict):
                outcome = Outcome("failed", "invalid_payload", "the payload is not an object")
            else:
                outcome = self._handlers.handle(str(command.get("kind", "")), payload)
            result = outcome.as_dict()
            # Recorded before it is reported: a crash between the two replays the same result.
            self._state.record(command_id, result)
            try:
                self._api.result(command_id, result)
            except CommandGoneError:
                log.info("command %s already has a terminal result", command_id)
            log.info("command %s %s: %s", command_id, command.get("kind"), outcome.status)
            reported += 1
        return reported
