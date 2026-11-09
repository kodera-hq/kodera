"""The agent's side of the Agent API's command loop (`contracts/agent-api.openapi.yaml`)."""

import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime
from typing import Any

from . import AGENT_VERSION


class CoreUnavailableError(Exception):
    pass


class CommandGoneError(Exception):
    """Core answered 409 on ack: the command is terminal, cancelled or expired. Do not execute."""


def now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


class CoreApi:
    def __init__(self, base_url: str, token: str, boot_id: str, timeout: float = 70.0) -> None:
        self._base, self._token, self._boot_id, self._timeout = base_url, token, boot_id, timeout
        self.poll_after_s = 30  # Core's hint for the next poll; it does not hold connections

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        request = urllib.request.Request(  # noqa: S310 - Core's own URL, from config
            self._base + path,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {self._token}", "Content-Type": "application/json"},
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:  # noqa: S310
                raw = response.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as exc:
            if exc.code == 409:
                raise CommandGoneError(path) from exc
            raise CoreUnavailableError(f"{method} {path} answered {exc.code}") from exc
        except (urllib.error.URLError, OSError) as exc:
            raise CoreUnavailableError(f"{method} {path}: {exc}") from exc

    def commands(self, kinds: tuple[str, ...], wait_s: int) -> list[dict[str, Any]]:
        query = urllib.parse.urlencode({"kinds": ",".join(kinds), "wait_s": wait_s, "max": 20})
        answer = self._request("GET", f"/agent/v1/commands?{query}")
        if not isinstance(answer, dict):
            return []
        poll_after = answer.get("poll_after_s")
        self.poll_after_s = (
            poll_after if isinstance(poll_after, int) and 1 <= poll_after <= 300 else 30
        )
        commands = answer.get("commands", [])
        return [c for c in commands if isinstance(c, dict)] if isinstance(commands, list) else []

    def ack(self, command_id: str) -> dict[str, Any]:
        answer: dict[str, Any] = self._request(
            "POST",
            f"/agent/v1/commands/{command_id}/ack",
            {"accepted_at": now(), "agent_version": AGENT_VERSION, "boot_id": self._boot_id},
        )
        return answer

    def result(self, command_id: str, outcome: dict[str, Any]) -> None:
        body: dict[str, Any] = {
            "command_id": command_id,
            "status": outcome["status"],
            "reported_at": now(),
        }
        if outcome["status"] == "failed":
            body["error_code"] = outcome["error_code"]
        if outcome.get("detail"):
            body["error_detail"] = outcome["detail"]
        if outcome.get("artefacts") is not None:
            body["artefacts"] = outcome["artefacts"]
        self._request("POST", f"/agent/v1/commands/{command_id}/result", body)
