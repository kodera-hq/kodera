"""Bounded JSON RPC to one private, RAM-only proximity broker process."""

from __future__ import annotations

import fcntl
import json
import os
import signal
import socket
import socketserver
import stat
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any
from uuid import UUID

from .services import ProximityBroker, ProximityRefusalError, assert_zero_gps_payload

MAX_REQUEST_BYTES = 16384
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
SOCKET_TIMEOUT = 2.0
FIELDS = {
    "health": set(),
    "bootstrap": {"workspace_id", "event_scope"},
    "checkin": {
        "principal_key",
        "workspace_id",
        "beacon_token_hex",
        "event_scope",
        "ttl_seconds",
        "status_note",
        "handle",
        "transport",
        "distance_band",
    },
    "resolve": {"principal_key", "workspace_id", "observed_tokens", "event_scope"},
    "nearby": {"principal_key", "workspace_id", "event_scope"},
    "checkout": {"principal_key", "workspace_id", "event_scope"},
    "inventory": {"workspace_id"},
    "forget": {"workspace_id", "principal_keys"},
    "erase_workspace": {"workspace_id"},
    "inspect_workspace": {"workspace_id"},
    "erase_account": {"identity_ids"},
    "inspect_account": {"identity_ids"},
}
REQUIRED = {
    "health": set(),
    "bootstrap": {"workspace_id"},
    "checkin": {"principal_key", "workspace_id", "beacon_token_hex"},
    "resolve": {"principal_key", "workspace_id", "observed_tokens"},
    "nearby": {"principal_key", "workspace_id"},
    "checkout": {"principal_key", "workspace_id"},
    "inventory": {"workspace_id"},
    "forget": {"workspace_id", "principal_keys"},
    "erase_workspace": {"workspace_id"},
    "inspect_workspace": {"workspace_id"},
    "erase_account": {"identity_ids"},
    "inspect_account": {"identity_ids"},
}


def unavailable() -> ProximityRefusalError:
    return ProximityRefusalError(503, reason="proximity_broker_unavailable")


def reject_constant(value: str) -> None:
    raise ValueError("non-standard JSON constant")


def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate broker field")
        result[key] = value
    return result


def socket_path(raw: str | None) -> Path:
    if not raw or not isinstance(raw, str):
        raise unavailable()
    path = Path(raw)
    if (
        not path.is_absolute()
        or str(path) != raw
        or ".." in path.parts
        or len(os.fsencode(raw)) > 100
        or any(ord(char) < 32 for char in raw)
    ):
        raise unavailable()
    try:
        parent = path.parent.stat()
        if (
            path.parent.resolve() != path.parent
            or parent.st_uid != os.geteuid()
            or parent.st_mode & 0o077
        ):
            raise unavailable()
    except OSError:
        raise unavailable() from None
    return path


class BrokerGateway:
    """Each API worker opens a short-lived connection; no local key/state fallback."""

    def __init__(self, path: str | None) -> None:
        self.path = socket_path(path)

    def call(self, operation: str, **arguments: Any) -> dict[str, Any]:
        payload = {
            "operation": operation,
            "arguments": {
                key: str(value) if isinstance(value, UUID) else value
                for key, value in arguments.items()
            },
        }
        try:
            raw = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode() + b"\n"
            if len(raw) > MAX_REQUEST_BYTES:
                raise unavailable()
            entry = self.path.lstat()
            if (
                not stat.S_ISSOCK(entry.st_mode)
                or entry.st_uid != os.geteuid()
                or entry.st_mode & 0o077
            ):
                raise unavailable()
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(SOCKET_TIMEOUT)
                connection.connect(str(self.path))
                connection.sendall(raw)
                with connection.makefile("rb") as stream:
                    response = stream.readline(MAX_RESPONSE_BYTES + 1)
            if len(response) > MAX_RESPONSE_BYTES or not response.endswith(b"\n"):
                raise unavailable()
            decoded = json.loads(
                response, object_pairs_hook=unique_object, parse_constant=reject_constant
            )
            if not isinstance(decoded, dict):
                raise unavailable()
            if set(decoded) == {"result"} and isinstance(decoded["result"], dict):
                return decoded["result"]
            if set(decoded) == {"error"} and isinstance(decoded["error"], dict):
                error = decoded["error"]
                if (
                    set(error) == {"status", "kind", "reason"}
                    and type(error["status"]) is int
                    and error["status"]
                    in {
                        400,
                        403,
                        409,
                        422,
                        503,
                    }
                ):
                    if (error["kind"] is None or isinstance(error["kind"], str)) and (
                        error["reason"] is None or isinstance(error["reason"], str)
                    ):
                        raise ProximityRefusalError(**error)
            raise unavailable()
        except (OSError, ValueError, TypeError, RecursionError):
            raise unavailable() from None

    def bootstrap(self, **arguments: Any) -> dict[str, Any]:
        return self.call("bootstrap", **arguments)

    def checkin(self, **arguments: Any) -> dict[str, Any]:
        return self.call("checkin", **arguments)

    def resolve(self, **arguments: Any) -> dict[str, Any]:
        return self.call("resolve", **arguments)

    def nearby(self, **arguments: Any) -> dict[str, Any]:
        return self.call("nearby", **arguments)

    def checkout(self, **arguments: Any) -> dict[str, Any]:
        return self.call("checkout", **arguments)

    def inventory(self, **arguments: Any) -> dict[str, Any]:
        return self.call("inventory", **arguments)

    def health(self) -> dict[str, Any]:
        return self.call("health")

    def forget(self, **arguments: Any) -> dict[str, Any]:
        return self.call("forget", **arguments)

    def erase_workspace(self, **arguments: Any) -> dict[str, Any]:
        return self.call("erase_workspace", **arguments)

    def inspect_workspace(self, **arguments: Any) -> dict[str, Any]:
        return self.call("inspect_workspace", **arguments)

    def erase_account(self, **arguments: Any) -> dict[str, Any]:
        return self.call("erase_account", **arguments)

    def inspect_account(self, **arguments: Any) -> dict[str, Any]:
        return self.call("inspect_account", **arguments)


def dispatch(broker: ProximityBroker, raw: bytes) -> dict[str, Any]:
    try:
        if len(raw) > MAX_REQUEST_BYTES or not raw.endswith(b"\n"):
            raise ValueError("invalid framing")
        payload = json.loads(raw, object_pairs_hook=unique_object, parse_constant=reject_constant)
        if not isinstance(payload, dict) or set(payload) != {"operation", "arguments"}:
            raise ValueError("invalid envelope")
        operation, arguments = payload["operation"], payload["arguments"]
        if (
            not isinstance(operation, str)
            or operation not in FIELDS
            or not isinstance(arguments, dict)
        ):
            raise ValueError("invalid operation")
        if not REQUIRED[operation] <= arguments.keys() or arguments.keys() - FIELDS[operation]:
            raise ValueError("invalid arguments")
        assert_zero_gps_payload(arguments)
        if "workspace_id" in arguments:
            workspace = arguments["workspace_id"]
            if (
                not isinstance(workspace, str)
                or str(UUID(workspace)) != workspace
                or UUID(workspace).int == 0
            ):
                raise ValueError("invalid workspace")
            arguments["workspace_id"] = UUID(workspace)
        for name in ("principal_keys", "identity_ids"):
            if name in arguments:
                values = arguments[name]
                if (
                    not isinstance(values, list)
                    or not 1 <= len(values) <= 128
                    or len(set(values)) != len(values)
                ):
                    raise ValueError("invalid identity batch")
                if any(
                    not isinstance(value, str) or str(UUID(value)) != value or UUID(value).int == 0
                    for value in values
                ):
                    raise ValueError("invalid identity")
        if operation in {"checkin", "resolve", "nearby", "checkout"}:
            principal = arguments["principal_key"]
            if (
                not isinstance(principal, str)
                or str(UUID(principal)) != principal
                or UUID(principal).int == 0
            ):
                raise ValueError("invalid principal")
        # Closed table: caller-controlled names never select arbitrary broker attributes.
        handlers: dict[str, Callable[..., dict[str, Any]]] = {
            "health": broker.health,
            "bootstrap": broker.bootstrap,
            "checkin": broker.checkin,
            "resolve": broker.resolve,
            "nearby": broker.nearby,
            "checkout": broker.checkout,
            "inventory": broker.inventory,
            "forget": broker.forget,
            "erase_workspace": broker.erase_workspace,
            "inspect_workspace": broker.inspect_workspace,
            "erase_account": broker.erase_account,
            "inspect_account": broker.inspect_account,
        }
        return {"result": handlers[operation](**arguments)}
    except ProximityRefusalError as failure:
        return {"error": {"status": failure.status, "kind": failure.kind, "reason": failure.reason}}
    except (ValueError, TypeError, KeyError, OverflowError, RecursionError, UnicodeError):
        return {
            "error": {
                "status": 400,
                "kind": "malformed-request",
                "reason": "invalid_broker_request",
            }
        }


class _Handler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        self.request.settimeout(SOCKET_TIMEOUT)
        try:
            raw = self.rfile.readline(MAX_REQUEST_BYTES + 1)
            reply = dispatch(self.server.broker, raw)  # type: ignore[attr-defined]
            encoded = json.dumps(reply, separators=(",", ":"), allow_nan=False).encode() + b"\n"
            if len(encoded) > MAX_RESPONSE_BYTES:
                encoded = b'{"error":{"status":503,"kind":null,"reason":"proximity_broker_unavailable"}}\n'
            self.wfile.write(encoded)
        except (OSError, ValueError, TypeError):
            return


class BrokerServer(socketserver.UnixStreamServer):
    request_queue_size = 32

    def __init__(self, path: str) -> None:
        self.path = socket_path(path)
        self.broker = ProximityBroker()
        self._bound = False
        self._lock_fd: int | None = os.open(
            str(self.path) + ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600
        )
        try:
            lock_info = os.fstat(self._lock_fd)
            if (
                not stat.S_ISREG(lock_info.st_mode)
                or lock_info.st_uid != os.geteuid()
                or lock_info.st_mode & 0o077
            ):
                raise unavailable()
            fcntl.flock(self._lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if self.path.exists():
                if not stat.S_ISSOCK(self.path.lstat().st_mode):
                    raise unavailable()
                self.path.unlink()
            super().__init__(str(self.path), _Handler)
            self._bound = True
            self.path.chmod(0o600)
        except BaseException:
            if self._lock_fd is not None:
                os.close(self._lock_fd)
                self._lock_fd = None
            self.broker.clear()
            raise

    def server_close(self) -> None:
        super().server_close()
        self.broker.clear()
        if self._bound:
            self.path.unlink(missing_ok=True)
            self._bound = False
        if self._lock_fd is not None:
            os.close(self._lock_fd)
            self._lock_fd = None


def main() -> int:
    if len(sys.argv) != 2:
        return 2
    try:
        with BrokerServer(sys.argv[1]) as server:

            def stop(_signal: int, _frame: Any) -> None:
                raise SystemExit(0)

            signal.signal(signal.SIGTERM, stop)
            signal.signal(signal.SIGINT, stop)
            server.serve_forever(poll_interval=0.1)
    except (OSError, ProximityRefusalError):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
