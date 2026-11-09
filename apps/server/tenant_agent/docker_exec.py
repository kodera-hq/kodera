"""Run a command inside one of the tenant's engine containers, through the Docker Engine API on its
unix socket. The image needs no Docker client: this is plain HTTP over AF_UNIX."""

import http.client
import io
import json
import socket
import tarfile
import urllib.parse
from dataclasses import dataclass
from typing import Any


class ExecError(Exception):
    """The container could not be found or the exec could not be run at all."""


class _UnixConnection(http.client.HTTPConnection):
    def __init__(self, path: str, timeout: float) -> None:
        super().__init__("localhost", timeout=timeout)
        self._path = path

    def connect(self) -> None:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self._path)
        self.sock = sock


@dataclass(frozen=True)
class ExecResult:
    exit_code: int
    output: str


class DockerExec:
    def __init__(self, socket_path: str, project: str, timeout: float = 120.0) -> None:
        self._socket = socket_path
        self._project = project
        self._timeout = timeout

    def _call(
        self, method: str, path: str, body: dict[str, Any] | None = None
    ) -> tuple[int, bytes]:
        connection = _UnixConnection(self._socket, self._timeout)
        try:
            payload = None if body is None else json.dumps(body).encode()
            headers = {"Content-Type": "application/json"} if payload is not None else {}
            connection.request(method, path, body=payload, headers=headers)
            response = connection.getresponse()
            return response.status, response.read()
        except OSError as exc:
            raise ExecError(f"docker socket: {exc}") from exc
        finally:
            connection.close()

    def container(self, service: str) -> str:
        filters = json.dumps(
            {
                "label": [
                    f"com.docker.compose.project={self._project}",
                    f"com.docker.compose.service={service}",
                ],
                "status": ["running"],
            }
        )
        status, body = self._call("GET", "/containers/json?filters=" + urllib.parse.quote(filters))
        found = json.loads(body) if status == 200 else []
        if not found:
            raise ExecError(f"no running container for service {service}")
        return str(found[0]["Id"])

    def exists(self, service: str) -> bool:
        """Whether the project holds a container for the service, running or not."""
        filters = json.dumps(
            {
                "label": [
                    f"com.docker.compose.project={self._project}",
                    f"com.docker.compose.service={service}",
                ]
            }
        )
        query = "all=1&filters=" + urllib.parse.quote(filters)
        status, body = self._call("GET", "/containers/json?" + query)
        if status != 200:
            raise ExecError(f"docker: listing the containers answered {status}")
        return bool(json.loads(body))

    def put_file(self, service: str, name: str, content: bytes) -> str:
        """Copy `content` to /tmp/<name> in the service's container, readable by its user.
        A member set can exceed what an environment variable may hold."""
        container = self.container(service)
        uid, gid = self._user(container)
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w") as archive:
            info = tarfile.TarInfo(name)
            # Owned by the container's user, so that it can delete the file once read: /tmp is
            # sticky, and the engine images run as an unprivileged user.
            info.size, info.mode, info.uid, info.gid = len(content), 0o600, uid, gid
            archive.addfile(info, io.BytesIO(content))
        status, _ = self._call_raw(
            "PUT", f"/containers/{container}/archive?path=/tmp", buffer.getvalue()
        )
        if status != 200:
            raise ExecError(f"copy into {service} answered {status}")
        return f"/tmp/{name}"  # noqa: S108 - inside the engine container, a random name, read once

    def _configured_user(self, container: str) -> str:
        status, body = self._call("GET", f"/containers/{container}/json")
        return str(json.loads(body).get("Config", {}).get("User", "")) if status == 200 else ""

    def _user(self, container: str) -> tuple[int, int]:
        user = self._configured_user(container)
        uid, _, group = user.partition(":")
        gid = group.partition(":")[0]  # the group a malformed `uid:gid:...` names first
        if not uid:
            return 0, 0  # no user configured: the container runs as root
        if not uid.isdigit():
            raise ExecError(f"the container user {user!r} is not numeric")
        return int(uid), int(gid) if gid.isdigit() else int(uid)

    def _call_raw(self, method: str, path: str, body: bytes) -> tuple[int, bytes]:
        connection = _UnixConnection(self._socket, self._timeout)
        try:
            connection.request(
                method, path, body=body, headers={"Content-Type": "application/x-tar"}
            )
            response = connection.getresponse()
            return response.status, response.read()
        except OSError as exc:
            raise ExecError(f"docker socket: {exc}") from exc
        finally:
            connection.close()

    def run(self, service: str, argv: list[str], env: dict[str, str]) -> ExecResult:
        container = self.container(service)
        create: dict[str, Any] = {
            "Cmd": argv,
            "Env": [f"{key}={value}" for key, value in env.items()],
            "AttachStdout": True,
            "AttachStderr": True,
            "Tty": True,
        }
        user = self._configured_user(container)
        if user.count(":") > 1:
            # Not `user:group` (Meet's image declares `1001:127:-1000`): an exec inheriting it
            # exits 126 before it starts. Run as its user and first group, never as group 0.
            uid, gid = self._user(container)
            create["User"] = f"{uid}:{gid}"
        status, body = self._call("POST", f"/containers/{container}/exec", create)
        if status != 201:
            raise ExecError(f"exec create answered {status}")
        exec_id = json.loads(body)["Id"]
        status, output = self._call(
            "POST", f"/exec/{exec_id}/start", {"Detach": False, "Tty": True}
        )
        if status != 200:
            raise ExecError(f"exec start answered {status}")
        status, inspected = self._call("GET", f"/exec/{exec_id}/json")
        exit_code = json.loads(inspected).get("ExitCode") if status == 200 else None
        if exit_code is None:
            raise ExecError("exec finished without an exit code")
        return ExecResult(int(exit_code), output.decode(errors="replace"))
