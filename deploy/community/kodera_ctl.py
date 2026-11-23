#!/usr/bin/env python3
"""Community self-host maintenance operations CLI (`kodera-ctl`).

Provides ordered, health-gated maintenance upgrades with pre-quiesce image
staging, ingress-closed atomic 0700/0600 PostgreSQL snapshots (preserving
security ACLs), clean-schema + complete immutable-sha256 automatic or 1-command
rollbacks, pre-ingress backend + WebRTC readiness gates, and fail-closed public
404 isolation checks.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import hmac
import importlib.util
import io
import json
import os
import re
import secrets
import shutil
import ssl
import stat
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Protocol

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CHECK_SCRIPT = ROOT / "scripts" / "ci" / "check-community-deploy.py"
DEPLOY_SCRIPT = HERE / "kodera_deploy.py"

if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import webrtc_probe

BACKUP_DIR_NAME = ".kodera-backups"
BACKUP_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SHA256_HEX_RE = re.compile(r"^[0-9a-f]{64}$")
IMAGE_ID_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
PUBLIC_DOMAIN_RE = re.compile(
    r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$"
)
ENV_LINE_RE = re.compile(r"^([A-Z][A-Z0-9_]*)=(.*)$")
SECRET_KEY_NAME_RE = re.compile(
    r"(?:^|_)(?:API)?KEYS?(?:_|$)|APIKEY|SECRET|PASSW(?:OR)?D|TOKEN|CREDENTIAL|PRIVATE|(?:^|_)PAT(?:_|$)"
)
PINNED_IMAGE_VALUE_RE = re.compile(
    r"^(?:sha256:[0-9a-f]{64}|[A-Za-z0-9][A-Za-z0-9._:/@-]{1,255})$"
)

TERMINATE_BACKENDS_SQL = (
    "SELECT pg_terminate_backend(pid) "
    "FROM pg_stat_activity "
    "WHERE datname = current_database() AND pid <> pg_backend_pid();"
)
RESET_PUBLIC_SCHEMA_SQL = (
    "BEGIN; "
    "DROP SCHEMA IF EXISTS public CASCADE; "
    "CREATE SCHEMA public; "
    "GRANT ALL ON SCHEMA public TO CURRENT_USER; "
    "GRANT USAGE ON SCHEMA public TO PUBLIC; "
    "COMMIT;"
)

INTERNAL_SERVER_READY_CODE = (
    "import json, sys, urllib.request; "
    "live = json.loads(urllib.request.urlopen('http://127.0.0.1:8000/health/live', timeout=3).read()); "
    "ready = json.loads(urllib.request.urlopen('http://127.0.0.1:8000/health/ready', timeout=3).read()); "
    "sys.exit(0 if live == {'status': 'alive'} and ready == {'status': 'ready', 'database': 'reachable'} else 1)"
)

# Backend runtime services in strict dependency order (excluding `caddy`, `migrate`, and one-shot init):
#   db, synapse-db, valkey -> proximity-broker, media-storage-worker, yjs-collab, synapse, livekit
#   -> server -> api-admission, room-access, [web], [tenant-agent].
BASE_BACKEND_RUNTIME_SERVICES: tuple[str, ...] = (
    "db",
    "synapse-db",
    "valkey",
    "proximity-broker",
    "media-storage-worker",
    "yjs-collab",
    "synapse",
    "livekit",
    "server",
    "api-admission",
    "room-access",
)


class CtlError(RuntimeError):
    """Base operational refusal or execution failure in kodera-ctl."""


class CtlCommandError(CtlError):
    """Raised when a subprocess command times out or fails OS execution."""


class CtlPreflightError(CtlError):
    """Raised when preflight guardrails refuse an unsafe stack or .env."""


class CtlBackupError(CtlError):
    """Raised when atomic backup creation or manifest verification fails."""


class CtlUpgradeError(CtlError):
    """Raised when staging, migration, or pre-ingress rollout fails."""


class CtlPostflightError(CtlError):
    """Raised when post-caddy public verification fails after the auto-rollback window closed."""


class CtlRollbackError(CtlError):
    """Raised when rollback verification or database/service restore fails."""


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str
    stderr: str


class CommandRunner(Protocol):
    def __call__(
        self,
        argv: Sequence[str],
        *,
        cwd: Path | None = None,
        stdout_fd: int | None = None,
        stdin_fd: int | None = None,
        timeout: float = 300.0,
    ) -> CommandResult: ...


@dataclass(frozen=True)
class HttpResponseData:
    status: int
    body: bytes


HttpFetcher = Callable[[str, float], HttpResponseData]
WebRtcProbeFn = Callable[..., dict[str, object]]


@dataclass(frozen=True)
class TurnProbeConfig:
    enabled: bool
    stun_host: str | None = None
    stun_port: int | None = None
    turn_url: str | None = None
    turn_username: str | None = None
    turn_password: str | None = None


@dataclass(frozen=True)
class StackContext:
    stack_dir: Path
    env_file: Path
    topology: str
    domain: str
    matrix_domain: str
    governance_enabled: bool
    federation_closed: bool
    caddy_blocks_federation: bool
    federation_allowlist: tuple[str, ...]
    postgres_user: str
    postgres_db: str
    env_sha256: str
    project_name: str | None
    turn_config: TurnProbeConfig
    secrets: frozenset[str]


@dataclass(frozen=True)
class BackupRecord:
    backup_id: str
    backup_dir: Path
    manifest: dict[str, object]


def _load_deploy_gate():
    spec = importlib.util.spec_from_file_location("kodera_ctl_deploy_check", CHECK_SCRIPT)
    if spec is None or spec.loader is None:
        raise CtlPreflightError(f"missing deploy gate script: {CHECK_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


_DEPLOY_GATE = None


def deploy_gate():
    global _DEPLOY_GATE
    if _DEPLOY_GATE is None:
        _DEPLOY_GATE = _load_deploy_gate()
    return _DEPLOY_GATE


def redact_secrets(text: str, secrets_set: Iterable[str]) -> str:
    """Replace any known secret material with `[REDACTED]` before logging or raising."""
    candidates = sorted(
        {s for s in secrets_set if isinstance(s, str) and len(s) >= 4},
        key=len,
        reverse=True,
    )
    out = text
    for item in candidates:
        out = out.replace(item, "[REDACTED]")
        quoted = urllib.parse.quote(item, safe="")
        if len(quoted) >= 4 and quoted != item:
            out = out.replace(quoted, "[REDACTED]")
    return out


def verify_path_ancestors_no_symlink(
    target: Path,
    *,
    must_exist: bool = True,
    error_cls: type[CtlError] = CtlPreflightError,
) -> Path:
    """Verify every non-root ancestor component of `target` is free of symbolic links."""
    try:
        return webrtc_probe.verify_path_ancestors_no_symlink(target, must_exist=must_exist)
    except ValueError as exc:
        raise error_cls(str(exc)) from None


def verify_directory_no_symlink(
    directory: Path,
    *,
    error_cls: type[CtlError] = CtlPreflightError,
) -> Path:
    """Verify `directory` and all its ancestors contain zero symlinks and return canonical path."""
    canonical = verify_path_ancestors_no_symlink(directory, must_exist=True, error_cls=error_cls)
    try:
        st = os.lstat(canonical)
    except OSError as exc:
        raise error_cls(
            f"directory unavailable ({directory}): {exc.strerror or 'os error'}"
        ) from None
    if stat.S_ISLNK(st.st_mode):
        raise error_cls(f"symbolic link directory refused: {directory}")
    if not stat.S_ISDIR(st.st_mode):
        raise error_cls(f"not a directory: {directory}")
    return canonical


def verify_child_no_symlink(
    real_base: Path,
    relative: str,
    *,
    error_cls: type[CtlError] = CtlPreflightError,
) -> Path:
    """Ensure `real_base` and every path component down to `relative` is free of symlinks."""
    verify_directory_no_symlink(real_base, error_cls=error_cls)
    parts = [p for p in Path(relative).parts if p not in ("", ".")]
    if any(p == ".." for p in parts):
        raise error_cls(f"path traversal refused: {relative}")
    current = real_base
    for part in parts:
        current = current / part
        try:
            st = os.lstat(current)
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise error_cls(
                f"cannot stat {current}: {exc.strerror or 'os error'}"
            ) from None
        if stat.S_ISLNK(st.st_mode):
            raise error_cls(f"symbolic link refused: {current}")
    return real_base.joinpath(*parts)


def read_regular_bytes_nofollow(
    path: Path,
    *,
    max_bytes: int = 16 * 1024 * 1024,
    error_cls: type[CtlError] = CtlPreflightError,
) -> bytes:
    """Read a regular file after full ancestor symlink validation and O_RDONLY | O_NOFOLLOW."""
    canonical = verify_path_ancestors_no_symlink(path, must_exist=True, error_cls=error_cls)
    try:
        st = os.lstat(canonical)
    except OSError as exc:
        raise error_cls(
            f"cannot access {path}: {exc.strerror or 'os error'}"
        ) from None
    if stat.S_ISLNK(st.st_mode):
        raise error_cls(f"symbolic link refused: {path}")
    if not stat.S_ISREG(st.st_mode):
        raise error_cls(f"not a regular file: {path}")

    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(canonical, flags)
    except OSError as exc:
        raise error_cls(
            f"cannot open {path}: {exc.strerror or 'os error'}"
        ) from None
    try:
        fst = os.fstat(fd)
        if not stat.S_ISREG(fst.st_mode):
            raise error_cls(f"not a regular file descriptor: {path}")
        if fst.st_size > max_bytes:
            raise error_cls(f"file exceeds {max_bytes} byte safety bound: {path}")
        chunks: list[bytes] = []
        remaining = max_bytes + 1
        while remaining > 0:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        if len(data) > max_bytes:
            raise error_cls(f"file exceeds {max_bytes} byte safety bound: {path}")
        return data
    except OSError as exc:
        raise error_cls(
            f"error reading {path}: {exc.strerror or 'os error'}"
        ) from None
    finally:
        with contextlib.suppress(OSError):
            os.close(fd)


def read_regular_utf8_nofollow(
    path: Path,
    *,
    max_bytes: int = 2 * 1024 * 1024,
    error_cls: type[CtlError] = CtlPreflightError,
) -> str:
    raw = read_regular_bytes_nofollow(path, max_bytes=max_bytes, error_cls=error_cls)
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        raise error_cls(f"file is not valid UTF-8 text: {path}") from None


def parse_operator_env(env_text: str) -> tuple[dict[str, str], frozenset[str], list[str]]:
    """Parse `.env` text without quoting raw values into error strings."""
    parsed: dict[str, str] = {}
    secrets_found: set[str] = set()
    errors: list[str] = []

    for idx, raw_line in enumerate(env_text.splitlines(), start=1):
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = ENV_LINE_RE.match(stripped)
        if not match:
            errors.append(f".env line {idx}: malformed assignment (value redacted)")
            continue
        key, raw_val = match.group(1), match.group(2).strip()
        if key in parsed:
            errors.append(f".env line {idx}: duplicate key '{key}'")
        unquoted = (
            raw_val[1:-1]
            if len(raw_val) >= 2 and raw_val[0] == raw_val[-1] and raw_val[0] in ("'", '"')
            else raw_val
        )
        parsed[key] = unquoted
        if unquoted and (SECRET_KEY_NAME_RE.search(key) or key == "KODERA_AUTH_TRUST"):
            secrets_found.add(unquoted)
            if raw_val != unquoted:
                secrets_found.add(raw_val)

    return parsed, frozenset(secrets_found), errors


def extract_turn_probe_config(env_map: Mapping[str, str]) -> TurnProbeConfig:
    """Extract optional STUN/TURN listener settings from `.env` (`TURN_*` or `KODERA_TURN_*`)."""
    turn_url = (env_map.get("KODERA_TURN_URL") or env_map.get("TURN_URL") or "").strip() or None
    turn_domain = (
        env_map.get("TURN_DOMAIN") or env_map.get("KODERA_TURN_DOMAIN") or ""
    ).strip() or None
    turn_port_raw = (
        env_map.get("TURN_UDP_PORT") or env_map.get("KODERA_TURN_UDP_PORT") or ""
    ).strip()
    stun_port_raw = (
        env_map.get("STUN_UDP_PORT") or env_map.get("KODERA_STUN_UDP_PORT") or ""
    ).strip()
    turn_username = (
        env_map.get("TURN_USERNAME") or env_map.get("KODERA_TURN_USERNAME") or ""
    ).strip() or None
    turn_password = (
        env_map.get("TURN_PASSWORD") or env_map.get("KODERA_TURN_PASSWORD") or ""
    ).strip() or None

    port: int | None = None
    for candidate in (turn_port_raw, stun_port_raw):
        if candidate:
            if not candidate.isdigit() or not (1 <= int(candidate) <= 65535):
                raise CtlPreflightError(f"preflight refused: invalid UDP port '{candidate}'")
            port = int(candidate)
            break

    has_turn = bool(turn_url or turn_domain or turn_port_raw or (turn_username and turn_password))
    has_stun = bool(stun_port_raw)
    if not has_turn and not has_stun:
        return TurnProbeConfig(enabled=False)

    effective_port = port or webrtc_probe.DEFAULT_TURN_PORT
    effective_host = turn_domain or (env_map.get("KODERA_DOMAIN") or "").strip() or None
    effective_url = turn_url
    if not effective_url and turn_username and turn_password and effective_host:
        effective_url = f"turn:{effective_host}:{effective_port}?transport=udp"

    return TurnProbeConfig(
        enabled=True,
        stun_host=effective_host,
        stun_port=effective_port,
        turn_url=effective_url,
        turn_username=turn_username,
        turn_password=turn_password,
    )


def validate_federation_posture(env_map: Mapping[str, str]) -> tuple[bool, tuple[str, ...]]:
    """Enforce federation closed by default unless an explicit domain allowlist is valid."""
    mode = env_map.get("KODERA_FEDERATION_MODE", "").strip()
    allowlist_raw = env_map.get("KODERA_MATRIX_FEDERATION_ALLOWLIST", "").strip()

    if mode == "open":
        raise CtlPreflightError(
            "preflight refused: KODERA_FEDERATION_MODE=open is forbidden; "
            "federation must stay closed unless an explicit domain allowlist is configured"
        )
    if mode not in ("", "closed", "partner"):
        raise CtlPreflightError(
            f"preflight refused: invalid KODERA_FEDERATION_MODE '{mode}'"
        )
    if mode == "closed" and allowlist_raw:
        raise CtlPreflightError(
            "preflight refused: KODERA_FEDERATION_MODE=closed conflicts with non-empty "
            "KODERA_MATRIX_FEDERATION_ALLOWLIST"
        )
    if mode == "partner" and not allowlist_raw:
        raise CtlPreflightError(
            "preflight refused: KODERA_FEDERATION_MODE=partner requires an explicit "
            "KODERA_MATRIX_FEDERATION_ALLOWLIST"
        )

    if not allowlist_raw:
        return True, ()

    parts = [entry.strip() for entry in allowlist_raw.split(",") if entry.strip()]
    if not parts or len(parts) > 32:
        raise CtlPreflightError(
            "preflight refused: KODERA_MATRIX_FEDERATION_ALLOWLIST must contain 1..32 public domains"
        )
    validated: list[str] = []
    for server_name in parts:
        if "*" in server_name or ":" in server_name:
            raise CtlPreflightError(
                "preflight refused: federation allowlist forbids wildcards, ports, and IP literals"
            )
        if not PUBLIC_DOMAIN_RE.fullmatch(server_name) or server_name.endswith(
            (".local", ".localhost", ".internal")
        ):
            raise CtlPreflightError(
                f"preflight refused: invalid federation allowlist domain '{server_name}'"
            )
        if server_name not in validated:
            validated.append(server_name)

    return False, tuple(validated)


def _check_caddy_closed_planes(caddy_text: str, *, label: str) -> bool:
    """Validate /agent, /staff, and /_synapse/admin are closed and return `caddy_blocks_federation`."""
    federation_routed = False
    for idx, raw_line in enumerate(caddy_text.splitlines(), start=1):
        code = raw_line.split("#", 1)[0].strip()
        if not code.startswith("@"):
            continue
        tokens = code.split()
        if len(tokens) >= 3 and tokens[1] == "path":
            matcher_name = tokens[0]
            paths = tokens[2:]
            if matcher_name not in ("@internal", "@matrix_closed"):
                for p in paths:
                    if p.startswith(("/agent", "/staff", "/_synapse/admin")):
                        raise CtlPreflightError(
                            f"{label}:{idx}: forbidden public route '{p}' on matcher {matcher_name}"
                        )
                    if p.startswith("/_matrix/federation"):
                        federation_routed = True
                        raise CtlPreflightError(
                            f"{label}:{idx}: forbidden public federation route '{p}' on Community Caddyfile"
                        )
    if "@internal path /agent /agent/* /staff /staff/*" not in caddy_text:
        raise CtlPreflightError(
            f"{label}: missing mandatory '@internal path /agent /agent/* /staff /staff/*' 404 block"
        )
    return not federation_routed


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def default_http_fetcher(url: str, timeout: float = 5.0) -> HttpResponseData:
    """Perform a single-hop HTTP(S) GET without following redirects."""
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ("https", "http"):
        raise CtlError(f"unsupported HTTP probe scheme: {parsed.scheme}")
    host = (parsed.hostname or "").lower()
    if parsed.scheme == "http" and host not in ("127.0.0.1", "::1", "localhost"):
        raise CtlError(f"plain HTTP probe permitted only on loopback, got {host}")

    handlers: list[urllib.request.BaseHandler] = [_NoRedirectHandler()]
    if parsed.scheme == "https":
        ctx = ssl.create_default_context()
        handlers.append(urllib.request.HTTPSHandler(context=ctx))
    opener = urllib.request.build_opener(*handlers)
    req = urllib.request.Request(url, method="GET", headers={"Accept": "application/json"})
    try:
        with opener.open(req, timeout=timeout) as resp:
            status = int(resp.status)
            body = resp.read(262_144)
            return HttpResponseData(status=status, body=body)
    except urllib.error.HTTPError as err:
        try:
            body = err.read(262_144)
        finally:
            err.close()
        return HttpResponseData(status=int(err.code), body=body)


def default_command_runner(
    argv: Sequence[str],
    *,
    cwd: Path | None = None,
    stdout_fd: int | None = None,
    stdin_fd: int | None = None,
    timeout: float = 300.0,
) -> CommandResult:
    """Execute argv-only subprocess (`shell=False`), wrapping OS/timeout errors into CtlCommandError."""
    if not argv or not all(isinstance(arg, str) for arg in argv):
        raise ValueError("argv must be a non-empty sequence of strings")

    clean_env = {
        key: os.environ[key]
        for key in (
            "PATH",
            "HOME",
            "USER",
            "LOGNAME",
            "TMPDIR",
            "DOCKER_HOST",
            "DOCKER_CONTEXT",
            "DOCKER_CONFIG",
        )
        if key in os.environ
    }
    clean_env["LC_ALL"] = "C"

    if stdout_fd is None and stdin_fd is None:
        try:
            completed = subprocess.run(
                list(argv),
                cwd=str(cwd) if cwd else None,
                env=clean_env,
                shell=False,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired:
            raise CtlCommandError(f"command timed out after {timeout}s: {argv[0]}") from None
        except OSError as exc:
            raise CtlCommandError(
                f"command execution failed ({argv[0]}): {exc.strerror or type(exc).__name__}"
            ) from None
        return CommandResult(
            returncode=completed.returncode,
            stdout=completed.stdout,
            stderr=completed.stderr,
        )

    with (
        tempfile.TemporaryFile() as err_tmp,
        tempfile.TemporaryFile() as out_tmp,
    ):
        try:
            proc = subprocess.Popen(
                list(argv),
                cwd=str(cwd) if cwd else None,
                env=clean_env,
                shell=False,
                stdin=stdin_fd if stdin_fd is not None else subprocess.DEVNULL,
                stdout=stdout_fd if stdout_fd is not None else out_tmp,
                stderr=err_tmp,
            )
        except OSError as exc:
            raise CtlCommandError(
                f"command spawn failed ({argv[0]}): {exc.strerror or type(exc).__name__}"
            ) from None
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            raise CtlCommandError(f"command timed out after {timeout}s: {argv[0]}") from None

        out_text = ""
        if stdout_fd is None:
            out_tmp.seek(0)
            out_text = out_tmp.read(65536).decode("utf-8", "replace")
        err_tmp.seek(0)
        err_text = err_tmp.read(65536).decode("utf-8", "replace")
        return CommandResult(
            returncode=int(proc.returncode or 0),
            stdout=out_text,
            stderr=err_text,
        )


def _invoke_runner(
    ctx: StackContext,
    runner: CommandRunner,
    argv: Sequence[str],
    *,
    stdout_fd: int | None = None,
    stdin_fd: int | None = None,
    timeout: float = 300.0,
) -> CommandResult:
    """Invoke `runner`, wrapping raw `TimeoutExpired` or `OSError` into CtlCommandError."""
    try:
        return runner(
            argv,
            cwd=ctx.stack_dir,
            stdout_fd=stdout_fd,
            stdin_fd=stdin_fd,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        label = argv[-1] if argv else "subprocess"
        raise CtlCommandError(f"command timed out after {timeout}s ({label})") from None
    except OSError as exc:
        clean = redact_secrets(str(exc.strerror or type(exc).__name__), ctx.secrets)
        raise CtlCommandError(f"command OS error: {clean}") from None


def build_compose_argv(
    ctx: StackContext,
    *,
    extra_compose_files: Sequence[Path] = (),
) -> list[str]:
    """Construct the exact `docker compose` base argv using absolutized `ctx.env_file`."""
    argv: list[str] = ["docker", "compose", "--env-file", str(ctx.env_file)]
    if ctx.project_name:
        argv.extend(["-p", ctx.project_name])
    argv.extend(["-f", str(ctx.stack_dir / "docker-compose.yml")])
    if ctx.topology == "split":
        argv.extend(["-f", str(ctx.stack_dir / "docker-compose.split.yml")])
    for extra in extra_compose_files:
        argv.extend(["-f", str(extra)])
    if ctx.governance_enabled:
        argv.extend(["--profile", "community-governance"])
    return argv


def socket_init_services(*, governance_enabled: bool) -> tuple[str, ...]:
    """One-shot socket/state ownership initializers required in the active topology."""
    if governance_enabled:
        return ("proximity-socket-init", "media-socket-init", "agent-state-init")
    return ("proximity-socket-init", "media-socket-init")


def backend_runtime_services(topology: str, *, governance_enabled: bool) -> tuple[str, ...]:
    """Ordered backend runtime services (excluding `caddy`, `migrate`, and one-shot initializers)."""
    if topology not in ("single", "split"):
        raise ValueError(f"invalid topology: {topology}")
    tail: list[str] = []
    if topology == "single":
        tail.append("web")
    if governance_enabled:
        tail.append("tenant-agent")
    return (*BASE_BACKEND_RUNTIME_SERVICES, *tail)


def topological_service_order(topology: str, *, governance_enabled: bool) -> tuple[str, ...]:
    """Ordered runtime services ending with `caddy` (strictly excluding `migrate`)."""
    return (*backend_runtime_services(topology, governance_enabled=governance_enabled), "caddy")


def expected_recovery_services(topology: str, *, governance_enabled: bool) -> tuple[str, ...]:
    """Complete set of services requiring immutable `sha256:` image IDs for rollback/recovery."""
    return (
        *socket_init_services(governance_enabled=governance_enabled),
        *topological_service_order(topology, governance_enabled=governance_enabled),
    )


def backend_writer_stop_order(topology: str, *, governance_enabled: bool) -> tuple[str, ...]:
    """Reverse dependency order of backend writer services (excluding `caddy` and data stores)."""
    return tuple(
        svc
        for svc in reversed(backend_runtime_services(topology, governance_enabled=governance_enabled))
        if svc not in ("db", "synapse-db", "valkey")
    )


def write_services_stop_order(topology: str, *, governance_enabled: bool) -> tuple[str, ...]:
    """Reverse dependency order starting with `caddy` first so public ingress closes immediately."""
    return ("caddy", *backend_writer_stop_order(topology, governance_enabled=governance_enabled))


def probe_origins_for_context(
    ctx: StackContext,
    *,
    base_url_override: str | None = None,
) -> tuple[str, str]:
    """Return `(api_origin, matrix_origin)` derived from `.env` or `--base-url`."""
    if base_url_override:
        trimmed = base_url_override.rstrip("/")
        return trimmed, trimmed
    if ctx.topology == "split":
        return f"https://api.{ctx.matrix_domain}", f"https://matrix.{ctx.domain}"
    single_origin = f"https://{ctx.domain}"
    return single_origin, single_origin


def verify_live_isolation_only(
    ctx: StackContext,
    *,
    base_url_override: str | None,
    http_fetcher: HttpFetcher,
    error_cls: type[CtlError] = CtlPreflightError,
) -> dict[str, int]:
    """Enforce live HTTP 404 on internal/closed planes across derived or overridden origins."""
    api_origin, matrix_origin = probe_origins_for_context(ctx, base_url_override=base_url_override)
    closed_checks: list[tuple[str, str]] = [
        (api_origin, "/agent/v1/commands"),
        (api_origin, "/staff/"),
        (matrix_origin, "/_synapse/admin/v1/server_version"),
    ]
    if ctx.federation_closed or ctx.caddy_blocks_federation:
        closed_checks.append((matrix_origin, "/_matrix/federation/v1/version"))

    observed: dict[str, int] = {}
    for origin, path in closed_checks:
        try:
            resp = http_fetcher(origin + path, 3.0)
        except (OSError, urllib.error.URLError, CtlError, ValueError) as exc:
            clean = redact_secrets(str(exc), ctx.secrets)
            hint = (
                " (pass --skip-preflight-http for a stopped/cold stack)"
                if error_cls is CtlPreflightError
                else ""
            )
            raise error_cls(
                f"live HTTP isolation check could not reach {origin}{path}{hint}: {clean}"
            ) from None
        observed[path] = resp.status
        if resp.status != 404:
            raise error_cls(
                f"live isolation check refused: closed route {path} returned HTTP {resp.status} (expected 404)"
            )
    return observed


def preflight_stack(
    *,
    env_file: Path,
    stack_dir: Path = HERE,
    project_name: str | None = None,
    base_url_override: str | None = None,
    skip_preflight_http: bool = True,
    http_fetcher: HttpFetcher | None = None,
    invoke_deploy_cli: bool = True,
) -> StackContext:
    """Validate stack files, `.env` invariants, federation closure, and closed internal APIs."""
    real_stack = verify_directory_no_symlink(stack_dir)
    canonical_env_file = verify_path_ancestors_no_symlink(env_file, must_exist=True)
    abs_env_file = Path(os.path.abspath(os.fspath(canonical_env_file)))
    env_raw_bytes = read_regular_bytes_nofollow(abs_env_file, max_bytes=262_144)
    try:
        env_raw_text = env_raw_bytes.decode("utf-8")
    except UnicodeDecodeError:
        raise CtlPreflightError(f".env file is not valid UTF-8 text: {env_file}") from None

    env_map, secrets_set, parse_errors = parse_operator_env(env_raw_text)
    if parse_errors:
        raise CtlPreflightError("; ".join(parse_errors))

    topology = env_map.get("KODERA_TOPOLOGY", "single").strip() or "single"
    if topology not in ("single", "split"):
        raise CtlPreflightError(f"preflight refused: invalid KODERA_TOPOLOGY '{topology}'")

    compose_path = verify_child_no_symlink(real_stack, "docker-compose.yml")
    caddy_path = verify_child_no_symlink(real_stack, "Caddyfile")
    compose_text = read_regular_utf8_nofollow(compose_path)
    caddy_text = read_regular_utf8_nofollow(caddy_path)

    env_example_candidate = verify_child_no_symlink(real_stack, ".env.example")
    if env_example_candidate.exists():
        env_example_text = read_regular_utf8_nofollow(env_example_candidate)
    else:
        env_example_text = read_regular_utf8_nofollow(HERE / ".env.example")

    single_blocks_fed = _check_caddy_closed_planes(caddy_text, label="Caddyfile")
    active_blocks_fed = single_blocks_fed

    gate = deploy_gate()
    stack_errors: list[str] = list(
        gate.check_community_deploy(compose_text, env_example_text, caddy_text)
    )

    if topology == "split" or (real_stack / "docker-compose.split.yml").exists():
        split_compose_path = verify_child_no_symlink(real_stack, "docker-compose.split.yml")
        split_caddy_path = verify_child_no_symlink(real_stack, "Caddyfile.split")
        if topology == "split" or (split_compose_path.exists() and split_caddy_path.exists()):
            split_compose_text = read_regular_utf8_nofollow(split_compose_path)
            split_caddy_text = read_regular_utf8_nofollow(split_caddy_path)
            split_blocks_fed = _check_caddy_closed_planes(split_caddy_text, label="Caddyfile.split")
            if topology == "split":
                active_blocks_fed = split_blocks_fed
            stack_errors.extend(
                gate.check_split_topology(split_compose_text, split_caddy_text, env_example_text)
            )
            stack_errors.extend(gate.effective_runtime_errors(compose_text, split_compose_text))

    if stack_errors:
        scrubbed = redact_secrets("; ".join(stack_errors[:6]), secrets_set)
        raise CtlPreflightError(f"stack guardrail refusal: {scrubbed}")

    companion_turn_keys = {
        "TURN_URL",
        "KODERA_TURN_URL",
        "TURN_DOMAIN",
        "KODERA_TURN_DOMAIN",
        "TURN_UDP_PORT",
        "KODERA_TURN_UDP_PORT",
        "TURN_USERNAME",
        "KODERA_TURN_USERNAME",
        "TURN_PASSWORD",
        "KODERA_TURN_PASSWORD",
        "STUN_UDP_PORT",
        "KODERA_STUN_UDP_PORT",
    }
    filtered_env_lines = [
        ln
        for ln in env_raw_text.splitlines()
        if not (
            "=" in ln
            and not ln.lstrip().startswith("#")
            and ln.lstrip().split("=", 1)[0].strip() in companion_turn_keys
        )
    ]
    filtered_env_text = "\n".join(filtered_env_lines) + "\n"

    env_errors = gate.preflight_env(env_example_text, filtered_env_text)
    if env_errors:
        scrubbed = redact_secrets("; ".join(env_errors[:6]), secrets_set)
        raise CtlPreflightError(f".env preflight refusal: {scrubbed}")

    has_companion_turn = len(filtered_env_lines) != len(env_raw_text.splitlines())
    if (
        invoke_deploy_cli
        and not has_companion_turn
        and real_stack == Path(os.path.realpath(HERE))
        and DEPLOY_SCRIPT.is_file()
    ):
        res = default_command_runner(
            [sys.executable, str(DEPLOY_SCRIPT), "--preflight-only", "--env-file", str(abs_env_file)],
            cwd=ROOT,
            timeout=30.0,
        )
        if res.returncode != 0:
            detail = redact_secrets((res.stderr or res.stdout).strip(), secrets_set)
            raise CtlPreflightError(f"kodera_deploy preflight refused: {detail or 'exit nonzero'}")

    federation_closed, allowlist = validate_federation_posture(env_map)
    turn_cfg = extract_turn_probe_config(env_map)
    if turn_cfg.turn_password:
        secrets_set = frozenset({*secrets_set, turn_cfg.turn_password})

    domain = env_map.get("KODERA_DOMAIN", "").strip()
    if not domain or not PUBLIC_DOMAIN_RE.fullmatch(domain):
        raise CtlPreflightError("preflight refused: KODERA_DOMAIN must be a valid public domain")
    matrix_domain = env_map.get("KODERA_MATRIX_DOMAIN", "").strip() or (
        domain.split(".", 1)[1] if domain.count(".") >= 2 else domain
    )
    governance_enabled = env_map.get("KODERA_DEFAULT_COMMUNITY_ORG_SLUG", "").strip() == "community"
    pg_user = env_map.get("POSTGRES_USER", "kodera").strip() or "kodera"
    pg_db = env_map.get("POSTGRES_DB", "kodera_server").strip() or "kodera_server"
    env_sha256 = hashlib.sha256(env_raw_bytes).hexdigest()

    ctx = StackContext(
        stack_dir=real_stack,
        env_file=abs_env_file,
        topology=topology,
        domain=domain,
        matrix_domain=matrix_domain,
        governance_enabled=governance_enabled,
        federation_closed=federation_closed,
        caddy_blocks_federation=active_blocks_fed,
        federation_allowlist=allowlist,
        postgres_user=pg_user,
        postgres_db=pg_db,
        env_sha256=env_sha256,
        project_name=project_name,
        turn_config=turn_cfg,
        secrets=secrets_set,
    )

    if not skip_preflight_http:
        active_http = default_http_fetcher if http_fetcher is None else http_fetcher
        verify_live_isolation_only(
            ctx,
            base_url_override=base_url_override,
            http_fetcher=active_http,
            error_cls=CtlPreflightError,
        )

    return ctx


def ensure_backup_root(stack_dir: Path) -> Path:
    """Create or verify `<stack>/.kodera-backups` with strict mode 0700 and no symlinks."""
    real_stack = verify_directory_no_symlink(stack_dir, error_cls=CtlBackupError)
    backup_root = real_stack / BACKUP_DIR_NAME
    try:
        st = os.lstat(backup_root)
    except FileNotFoundError:
        try:
            os.mkdir(backup_root, 0o700)
            os.chmod(backup_root, 0o700)
            st = os.lstat(backup_root)
        except OSError as exc:
            raise CtlBackupError(
                f"cannot initialize backup directory {backup_root}: {exc.strerror or 'os error'}"
            ) from None
    except OSError as exc:
        raise CtlBackupError(
            f"cannot access backup directory {backup_root}: {exc.strerror or 'os error'}"
        ) from None

    if stat.S_ISLNK(st.st_mode):
        raise CtlBackupError(f"symbolic link backup directory refused: {backup_root}")
    if not stat.S_ISDIR(st.st_mode):
        raise CtlBackupError(f"backup root is not a directory: {backup_root}")
    if os.path.realpath(backup_root) != str(backup_root):
        raise CtlBackupError(f"backup directory reached through symbolic link: {backup_root}")

    mode = stat.S_IMODE(st.st_mode)
    if mode != 0o700:
        try:
            os.chmod(backup_root, 0o700)
            rechecked = stat.S_IMODE(os.lstat(backup_root).st_mode)
        except OSError as exc:
            raise CtlBackupError(
                f"cannot enforce 0700 mode on {backup_root}: {exc.strerror or 'os error'}"
            ) from None
        if rechecked != 0o700:
            raise CtlBackupError(f"backup directory must have mode 0700: {backup_root}")
    return backup_root


def _fsync_directory(directory: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        dir_fd = os.open(directory, flags)
    except OSError:
        return
    try:
        os.fsync(dir_fd)
    except OSError:
        pass
    finally:
        with contextlib.suppress(OSError):
            os.close(dir_fd)


def _write_atomic_0600_bytes(directory: Path, filename: str, payload: bytes) -> Path:
    """Atomically write `filename` inside `directory` with mode 0600, wrapping OS errors."""
    target = verify_child_no_symlink(directory, filename, error_cls=CtlBackupError)
    tmp_name = f".{filename}.{secrets.token_hex(6)}.tmp"
    tmp_path = verify_child_no_symlink(directory, tmp_name, error_cls=CtlBackupError)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(tmp_path, flags, 0o600)
    except OSError as exc:
        raise CtlBackupError(
            f"cannot create temporary backup file {filename}: {exc.strerror or 'os error'}"
        ) from None

    closed = False
    try:
        os.fchmod(fd, 0o600)
        view = memoryview(payload)
        written = 0
        while written < len(view):
            written += os.write(fd, view[written:])
        os.fsync(fd)
        os.close(fd)
        closed = True

        try:
            existing_st = os.lstat(target)
            if stat.S_ISLNK(existing_st.st_mode):
                with contextlib.suppress(OSError):
                    os.unlink(tmp_path)
                raise CtlBackupError(f"symbolic link target refused: {target}")
        except FileNotFoundError:
            pass

        os.replace(tmp_path, target)
        _fsync_directory(directory)
        return target
    except CtlError:
        if not closed:
            with contextlib.suppress(OSError):
                os.close(fd)
        with contextlib.suppress(OSError):
            os.unlink(tmp_path)
        raise
    except OSError as exc:
        if not closed:
            with contextlib.suppress(OSError):
                os.close(fd)
        with contextlib.suppress(OSError):
            os.unlink(tmp_path)
        raise CtlBackupError(
            f"filesystem error writing {filename}: {exc.strerror or 'os error'}"
        ) from None


def _hash_regular_0600_file(path: Path) -> tuple[str, int]:
    """Verify `path` is a non-symlink regular file with mode 0600 and stream its SHA-256 + size."""
    verify_path_ancestors_no_symlink(path, must_exist=True, error_cls=CtlBackupError)
    try:
        st = os.lstat(path)
    except OSError as exc:
        raise CtlBackupError(
            f"backup file missing or unreadable ({path.name}): {exc.strerror or 'os error'}"
        ) from None
    if stat.S_ISLNK(st.st_mode):
        raise CtlBackupError(f"symbolic link backup file refused: {path}")
    if not stat.S_ISREG(st.st_mode):
        raise CtlBackupError(f"backup entry is not a regular file: {path}")
    mode = stat.S_IMODE(st.st_mode)
    if (mode & 0o077) != 0:
        raise CtlBackupError(
            f"backup file {path.name} has insecure mode {oct(mode)} (expected 0600)"
        )

    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise CtlBackupError(
            f"cannot open backup file {path.name}: {exc.strerror or 'os error'}"
        ) from None
    try:
        fst = os.fstat(fd)
        if not stat.S_ISREG(fst.st_mode):
            raise CtlBackupError(f"backup descriptor is not a regular file: {path}")
        digest = hashlib.sha256()
        total = 0
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            digest.update(chunk)
            total += len(chunk)
        return digest.hexdigest(), total
    except OSError as exc:
        raise CtlBackupError(
            f"error hashing backup file {path.name}: {exc.strerror or 'os error'}"
        ) from None
    finally:
        with contextlib.suppress(OSError):
            os.close(fd)


def _parse_json_lines_or_array(raw_out: str) -> list[dict[str, object]]:
    stripped = raw_out.strip()
    if not stripped:
        return []
    try:
        if stripped.startswith("["):
            arr = json.loads(stripped)
            return [item for item in arr if isinstance(item, dict)] if isinstance(arr, list) else []
        rows: list[dict[str, object]] = []
        for line in stripped.splitlines():
            ln = line.strip()
            if ln:
                obj = json.loads(ln)
                if isinstance(obj, dict):
                    rows.append(obj)
        return rows
    except ValueError:
        return []


def capture_running_images(
    ctx: StackContext,
    runner: CommandRunner,
    *,
    error_cls: type[CtlError] = CtlBackupError,
) -> dict[str, dict[str, str]]:
    """Capture deployed service images and explicitly mark newly introduced target services."""
    gate = deploy_gate()
    compose_text = read_regular_utf8_nofollow(ctx.stack_dir / "docker-compose.yml", error_cls=error_cls)
    services_spec = gate.parse_compose_services(compose_text)
    expected = expected_recovery_services(
        ctx.topology, governance_enabled=ctx.governance_enabled
    )
    expected_set = set(expected)

    present_services: set[str] = set()
    recorded: dict[str, dict[str, str]] = {svc: {} for svc in expected}
    for svc_name in expected:
        spec = services_spec.get(svc_name)
        if spec and spec.image:
            recorded[svc_name]["configured_image"] = spec.image

    base_argv = build_compose_argv(ctx)
    # 1. Inspect running & exited one-shot containers (`ps -a`) for exact container `.Image` sha256 IDs.
    ps_res = _invoke_runner(ctx, runner, [*base_argv, "ps", "-a", "--format", "json"], timeout=30.0)
    if ps_res.returncode != 0:
        raise error_cls("cannot inspect previously deployed containers")
    if ps_res.stdout.strip():
        for entry in _parse_json_lines_or_array(ps_res.stdout):
            svc = str(entry.get("Service") or entry.get("service") or "").strip()
            cid = str(entry.get("ID") or entry.get("Id") or "").strip()
            img_label = str(entry.get("Image") or "").strip()
            if svc not in expected_set:
                continue
            present_services.add(svc)
            info = recorded[svc]
            if img_label:
                info["running_tag"] = img_label
            if cid:
                insp = _invoke_runner(
                    ctx,
                    runner,
                    ["docker", "inspect", "--format", "{{json .}}", cid],
                    timeout=20.0,
                )
                if insp.returncode == 0 and insp.stdout.strip():
                    try:
                        insp_doc = json.loads(insp.stdout.strip())
                        if isinstance(insp_doc, list) and insp_doc:
                            insp_doc = insp_doc[0]
                        if isinstance(insp_doc, dict):
                            image_id = str(insp_doc.get("Image") or "").strip()
                            if IMAGE_ID_RE.fullmatch(image_id):
                                info["image_id"] = image_id
                            cfg = insp_doc.get("Config")
                            if isinstance(cfg, dict) and cfg.get("Image"):
                                info.setdefault("running_tag", str(cfg["Image"]))
                    except ValueError:
                        pass

    # 2. For any expected service (e.g. one-shot init or static image) not resolved from `ps -a`,
    # inspect via `docker compose images` and `docker image inspect` to obtain its local `sha256:` ID.
    missing = [svc for svc in expected if not IMAGE_ID_RE.fullmatch(recorded[svc].get("image_id", ""))]
    if missing:
        imgs_res = _invoke_runner(ctx, runner, [*base_argv, "images", "--format", "json"], timeout=30.0)
        compose_img_candidates: dict[str, list[str]] = {}
        if imgs_res.returncode == 0 and imgs_res.stdout.strip():
            for item in _parse_json_lines_or_array(imgs_res.stdout):
                svc_key = str(
                    item.get("Service") or item.get("ContainerName") or ""
                ).strip()
                repo = str(item.get("Repository") or "").strip()
                tag = str(item.get("Tag") or "").strip()
                raw_id = str(item.get("ID") or "").strip()
                if svc_key in expected_set:
                    refs = compose_img_candidates.setdefault(svc_key, [])
                    if IMAGE_ID_RE.fullmatch(raw_id) or re.fullmatch(r"[0-9a-f]{12,64}", raw_id):
                        refs.append(raw_id)
                    if repo and tag and repo != "<none>" and tag != "<none>":
                        refs.append(f"{repo}:{tag}")

        project_prefix = ctx.project_name or ctx.stack_dir.name
        for svc in missing:
            info = recorded[svc]
            candidates: list[str] = []
            if info.get("running_tag"):
                candidates.append(info["running_tag"])
            if info.get("configured_image"):
                candidates.append(info["configured_image"])
            candidates.extend(compose_img_candidates.get(svc, ()))
            candidates.append(f"{project_prefix}-{svc}:latest")

            for ref in candidates:
                if not ref:
                    continue
                insp = _invoke_runner(
                    ctx,
                    runner,
                    ["docker", "image", "inspect", "--format", "{{.Id}}", ref],
                    timeout=15.0,
                )
                resolved = insp.stdout.strip()
                if insp.returncode == 0 and IMAGE_ID_RE.fullmatch(resolved):
                    info["image_id"] = resolved
                    if "@" not in ref and not ref.startswith("sha256:"):
                        info.setdefault("running_tag", ref)
                    break

    initializers = set(socket_init_services(governance_enabled=ctx.governance_enabled))
    for svc in expected:
        if svc not in present_services and (
            svc not in initializers or not recorded[svc].get("image_id")
        ):
            # A cached target image does not prove that a runtime service was deployed.
            # Removed one-shot initializer containers may still use their verified local image.
            recorded[svc] = {"state": "new_service"}
    validate_recovery_images(ctx, recorded, runner, error_cls=error_cls)
    return recorded


def validate_recovery_images(
    ctx: StackContext,
    images_map: object,
    runner: CommandRunner,
    *,
    error_cls: type[CtlError] = CtlRollbackError,
) -> dict[str, str]:
    """Verify immutable deployed images, admitting explicit new-service markers for target additions."""
    if not isinstance(images_map, Mapping) or not images_map:
        raise error_cls("recovery image inventory is missing or empty")

    expected = expected_recovery_services(
        ctx.topology, governance_enabled=ctx.governance_enabled
    )
    pinned: dict[str, str] = {}
    for svc in expected:
        meta = images_map.get(svc)
        if not isinstance(meta, Mapping):
            raise error_cls(f"recovery image inventory missing required service '{svc}'")
        if meta == {"state": "new_service"}:
            if svc in {"db", "synapse-db", "server", "caddy"}:
                raise error_cls(f"required deployed service '{svc}' is absent")
            continue
        image_id = str(meta.get("image_id") or "").strip()
        if not IMAGE_ID_RE.fullmatch(image_id):
            raise error_cls(
                f"service '{svc}' lacks an immutable sha256 image_id in recovery inventory"
            )
        insp = _invoke_runner(
            ctx,
            runner,
            ["docker", "image", "inspect", "--format", "{{.Id}}", image_id],
            timeout=20.0,
        )
        resolved = insp.stdout.strip()
        if insp.returncode != 0 or resolved != image_id:
            raise error_cls(
                f"immutable recovery image missing locally for service '{svc}': {image_id}"
            )
        pinned[svc] = image_id

    return pinned


def _stream_pg_dump(
    ctx: StackContext,
    runner: CommandRunner,
    *,
    service: str,
    db_user: str,
    db_name: str,
    dest_dir: Path,
    filename: str,
) -> dict[str, object]:
    """Stream `docker compose exec -T <svc> pg_dump -Fc --no-owner` (preserving ACLs) into 0600 file."""
    dump_path = verify_child_no_symlink(dest_dir, filename, error_cls=CtlBackupError)
    open_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(dump_path, open_flags, 0o600)
    except OSError as exc:
        raise CtlBackupError(
            f"cannot create dump file {filename}: {exc.strerror or 'os error'}"
        ) from None

    closed = False
    try:
        os.fchmod(fd, 0o600)
        argv = [
            *build_compose_argv(ctx),
            "exec",
            "-T",
            service,
            "pg_dump",
            "-Fc",
            "--no-owner",
            "-U",
            db_user,
            "-d",
            db_name,
        ]
        res = _invoke_runner(ctx, runner, argv, stdout_fd=fd, timeout=300.0)
        os.fsync(fd)
        os.close(fd)
        closed = True
    except CtlError as err:
        if not closed:
            with contextlib.suppress(OSError):
                os.close(fd)
        with contextlib.suppress(OSError):
            os.unlink(dump_path)
        if isinstance(err, CtlBackupError):
            raise
        raise CtlBackupError(redact_secrets(str(err), ctx.secrets)) from None
    except OSError as exc:
        if not closed:
            with contextlib.suppress(OSError):
                os.close(fd)
        with contextlib.suppress(OSError):
            os.unlink(dump_path)
        raise CtlBackupError(
            f"filesystem error streaming {filename}: {exc.strerror or 'os error'}"
        ) from None

    if res.returncode != 0:
        with contextlib.suppress(OSError):
            os.unlink(dump_path)
        detail = redact_secrets(res.stderr.strip(), ctx.secrets)
        raise CtlBackupError(
            f"pg_dump failed on service '{service}' (exit {res.returncode}): {detail or 'no stderr'}"
        )

    sha256_hex, size_bytes = _hash_regular_0600_file(dump_path)
    if size_bytes == 0:
        with contextlib.suppress(OSError):
            os.unlink(dump_path)
        raise CtlBackupError(f"pg_dump produced an empty archive for service '{service}'")

    return {
        "filename": filename,
        "sha256": sha256_hex,
        "size_bytes": size_bytes,
    }


RECOVERY_CONFIG_FILES = (
    "Caddyfile", "Caddyfile.split", "docker-compose.yml", "compose.yaml", "docker-compose.split.yml",
)


def _capture_recovery_config(ctx: StackContext) -> dict[str, bytes]:
    """Capture routing and service definitions before any upgrade staging mutation."""
    captured = {}
    for name in RECOVERY_CONFIG_FILES:
        path = verify_child_no_symlink(ctx.stack_dir, name, error_cls=CtlBackupError)
        if path.exists():
            captured[name] = read_regular_bytes_nofollow(path, error_cls=CtlBackupError)
    return captured


def _load_recovery_config(record: BackupRecord) -> dict[str, bytes]:
    """Verify optional config snapshots; legacy database-only backups remain readable."""
    snapshots = record.manifest.get("config_snapshots", {})
    if not isinstance(snapshots, dict):
        raise CtlRollbackError("invalid config snapshot inventory")
    captured = {}
    for name, meta in snapshots.items():
        if name not in RECOVERY_CONFIG_FILES or not isinstance(meta, dict):
            raise CtlRollbackError("invalid config snapshot entry")
        filename = f"config-{name}"
        if meta.get("filename") != filename:
            raise CtlRollbackError("invalid config snapshot filename")
        path = verify_child_no_symlink(record.backup_dir, filename, error_cls=CtlRollbackError)
        try:
            _hash_regular_0600_file(path)
            payload = read_regular_bytes_nofollow(path, error_cls=CtlRollbackError)
        except CtlBackupError as exc:
            raise CtlRollbackError(str(exc)) from None
        actual_sha, actual_size = hashlib.sha256(payload).hexdigest(), len(payload)
        expected_sha = meta.get("sha256")
        if (
            not isinstance(expected_sha, str)
            or not SHA256_HEX_RE.fullmatch(expected_sha)
            or not hmac.compare_digest(actual_sha, expected_sha)
            or actual_size != meta.get("size_bytes")
        ):
            raise CtlRollbackError(f"tampered or corrupted config snapshot: {name}")
        captured[name] = payload
    return captured


def _restore_recovery_config(ctx: StackContext, captured: Mapping[str, bytes]) -> None:
    """Replace each previous config atomically while ingress and writers are stopped."""
    try:
        for name, payload in captured.items():
            _write_atomic_0600_bytes(ctx.stack_dir, name, payload)
    except CtlBackupError as exc:
        raise CtlRollbackError(str(exc)) from None


def _restore_recovery_routing(ctx: StackContext, images: Mapping[str, object]) -> None:
    """Remove routes to an admission service absent from the recovered deployment."""
    if images.get("api-admission") != {"state": "new_service"}:
        return
    for name in ("Caddyfile", "Caddyfile.split"):
        path = verify_child_no_symlink(ctx.stack_dir, name, error_cls=CtlRollbackError)
        if path.exists():
            payload = read_regular_bytes_nofollow(path, error_cls=CtlRollbackError)
            if b"api-admission:8080" in payload:
                _restore_recovery_config(
                    ctx, {name: payload.replace(b"api-admission:8080", b"server:8000")}
                )


def create_backup(
    ctx: StackContext,
    *,
    runner: CommandRunner | None = None,
    backup_id_override: str | None = None,
    pre_captured_images: dict[str, dict[str, str]] | None = None,
    pre_captured_config: Mapping[str, bytes] | None = None,
) -> BackupRecord:
    """Create an atomic backup via `.kodera-backups/.staging-<id>-<pid>` -> `<id>` rename."""
    # Standalone backups preserve the checkout at invocation, before image inspection or dumps.
    # Upgrade supplies its own pre-staging snapshot; existing backup directories are immutable.
    config = _capture_recovery_config(ctx) if pre_captured_config is None else pre_captured_config
    active_runner = default_command_runner if runner is None else runner
    backup_root = ensure_backup_root(ctx.stack_dir)
    utc_now = datetime.now(timezone.utc)
    ts_label = utc_now.strftime("%Y%m%dT%H%M%SZ")
    backup_id = backup_id_override or f"{ts_label}-{secrets.token_hex(4)}"
    if not BACKUP_ID_RE.fullmatch(backup_id):
        raise CtlBackupError(f"invalid backup identifier: {backup_id}")

    final_dir = verify_child_no_symlink(backup_root, backup_id, error_cls=CtlBackupError)
    try:
        os.lstat(final_dir)
    except FileNotFoundError:
        pass
    except OSError as exc:
        raise CtlBackupError(
            f"cannot inspect backup destination {final_dir}: {exc.strerror or 'os error'}"
        ) from None
    else:
        raise CtlBackupError(f"backup snapshot already exists: {backup_id}")

    staging_name = f".staging-{backup_id}-{os.getpid()}-{secrets.token_hex(3)}"
    staging_dir = verify_child_no_symlink(backup_root, staging_name, error_cls=CtlBackupError)
    try:
        os.mkdir(staging_dir, 0o700)
        os.chmod(staging_dir, 0o700)
    except OSError as exc:
        raise CtlBackupError(
            f"cannot create staging directory {staging_dir}: {exc.strerror or 'os error'}"
        ) from None

    try:
        st = os.lstat(staging_dir)
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode) or stat.S_IMODE(st.st_mode) != 0o700:
            raise CtlBackupError(f"staging directory failed 0700/no-symlink check: {staging_dir}")

        if pre_captured_images is not None:
            validate_recovery_images(
                ctx, pre_captured_images, active_runner, error_cls=CtlBackupError
            )
            images = pre_captured_images
        else:
            images = capture_running_images(ctx, active_runner, error_cls=CtlBackupError)

        config_snapshots = {}
        for name, payload in config.items():
            filename = f"config-{name}"
            _write_atomic_0600_bytes(staging_dir, filename, payload)
            config_snapshots[name] = {
                "filename": filename,
                "sha256": hashlib.sha256(payload).hexdigest(),
                "size_bytes": len(payload),
            }

        core_dump = _stream_pg_dump(
            ctx,
            active_runner,
            service="db",
            db_user=ctx.postgres_user,
            db_name=ctx.postgres_db,
            dest_dir=staging_dir,
            filename="kodera_server.dump",
        )
        synapse_dump = _stream_pg_dump(
            ctx,
            active_runner,
            service="synapse-db",
            db_user="synapse",
            db_name="synapse",
            dest_dir=staging_dir,
            filename="synapse.dump",
        )

        manifest: dict[str, object] = {
            "schema_version": 1,
            "config_snapshots": config_snapshots,
            "backup_id": backup_id,
            "created_at": utc_now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "topology": ctx.topology,
            "domain": ctx.domain,
            "env_sha256": ctx.env_sha256,
            "postgres_user": ctx.postgres_user,
            "postgres_db": ctx.postgres_db,
            "synapse_db_user": "synapse",
            "synapse_db_name": "synapse",
            "runtime_services": [
                svc for svc in topological_service_order(
                    ctx.topology, governance_enabled=ctx.governance_enabled
                ) if images[svc].get("state") != "new_service"
            ],
            "dumps": {
                "kodera_server": core_dump,
                "synapse": synapse_dump,
            },
            "images": images,
            "new_services": sorted(
                svc for svc, meta in images.items() if meta.get("state") == "new_service"
            ),
        }

        manifest_bytes = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
        _write_atomic_0600_bytes(staging_dir, "manifest.json", manifest_bytes)
        _fsync_directory(staging_dir)

        try:
            os.lstat(final_dir)
        except FileNotFoundError:
            pass
        else:
            raise CtlBackupError(f"backup snapshot target appeared concurrently: {backup_id}")

        os.replace(staging_dir, final_dir)
        _fsync_directory(backup_root)
    except CtlBackupError:
        if staging_dir.exists() and not staging_dir.is_symlink():
            shutil.rmtree(staging_dir, ignore_errors=True)
        raise
    except CtlError as err:
        if staging_dir.exists() and not staging_dir.is_symlink():
            shutil.rmtree(staging_dir, ignore_errors=True)
        raise CtlBackupError(redact_secrets(str(err), ctx.secrets)) from None
    except OSError as exc:
        if staging_dir.exists() and not staging_dir.is_symlink():
            shutil.rmtree(staging_dir, ignore_errors=True)
        raise CtlBackupError(
            f"filesystem error publishing backup {backup_id}: {exc.strerror or 'os error'}"
        ) from None

    return BackupRecord(backup_id=backup_id, backup_dir=final_dir, manifest=manifest)


def _has_valid_manifest_file(snapshot_dir: Path) -> bool:
    manifest_path = snapshot_dir / "manifest.json"
    try:
        st = os.lstat(manifest_path)
    except OSError:
        return False
    return stat.S_ISREG(st.st_mode) and not stat.S_ISLNK(st.st_mode)


def resolve_and_verify_backup(stack_dir: Path, backup_selector: str = "latest") -> BackupRecord:
    """Resolve `latest` (ignoring `.staging-*` & incomplete dirs) or `<id>`, verifying SHA-256 digests."""
    backup_root = ensure_backup_root(stack_dir)

    if backup_selector == "latest":
        candidates: list[str] = []
        for entry in sorted(os.listdir(backup_root)):
            if entry.startswith("."):
                continue
            entry_path = backup_root / entry
            st = os.lstat(entry_path)
            if stat.S_ISLNK(st.st_mode):
                raise CtlRollbackError(f"symbolic link inside backup root refused: {entry_path}")
            if stat.S_ISDIR(st.st_mode) and _has_valid_manifest_file(entry_path):
                candidates.append(entry)
        if not candidates:
            raise CtlRollbackError(f"no complete backups available in {backup_root}")
        selected_id = candidates[-1]
    else:
        if backup_selector.startswith(".") or not BACKUP_ID_RE.fullmatch(backup_selector):
            raise CtlRollbackError(f"invalid backup identifier '{backup_selector}'")
        selected_id = backup_selector

    snapshot_dir = verify_child_no_symlink(backup_root, selected_id, error_cls=CtlRollbackError)
    try:
        dir_st = os.lstat(snapshot_dir)
    except FileNotFoundError:
        raise CtlRollbackError(f"backup snapshot not found: {selected_id}") from None
    if stat.S_ISLNK(dir_st.st_mode) or not stat.S_ISDIR(dir_st.st_mode):
        raise CtlRollbackError(f"backup snapshot is not a real directory: {snapshot_dir}")
    if (stat.S_IMODE(dir_st.st_mode) & 0o077) != 0:
        raise CtlRollbackError(
            f"backup directory has insecure permissions {oct(stat.S_IMODE(dir_st.st_mode))} (expected 0700)"
        )

    manifest_path = verify_child_no_symlink(snapshot_dir, "manifest.json", error_cls=CtlRollbackError)
    if not manifest_path.exists():
        raise CtlRollbackError(f"incomplete backup '{selected_id}': manifest.json is missing")
    try:
        _hash_regular_0600_file(manifest_path)
    except CtlBackupError as exc:
        raise CtlRollbackError(str(exc)) from None

    try:
        manifest = json.loads(read_regular_utf8_nofollow(manifest_path, error_cls=CtlRollbackError))
    except ValueError as exc:
        raise CtlRollbackError(f"corrupted manifest.json in backup '{selected_id}'") from exc

    if not isinstance(manifest, dict) or manifest.get("schema_version") != 1:
        raise CtlRollbackError(f"unsupported manifest schema in backup '{selected_id}'")
    if manifest.get("backup_id") != selected_id:
        raise CtlRollbackError("backup manifest_id mismatch")

    dumps = manifest.get("dumps")
    if not isinstance(dumps, dict):
        raise CtlRollbackError("backup manifest missing 'dumps' inventory")

    for logical_name, expected_filename in (
        ("kodera_server", "kodera_server.dump"),
        ("synapse", "synapse.dump"),
    ):
        meta = dumps.get(logical_name)
        if not isinstance(meta, dict):
            raise CtlRollbackError(f"backup manifest missing '{logical_name}' dump entry")
        fname = meta.get("filename")
        exp_sha = meta.get("sha256")
        exp_size = meta.get("size_bytes")
        if (
            fname != expected_filename
            or not isinstance(exp_sha, str)
            or not SHA256_HEX_RE.fullmatch(exp_sha)
            or not isinstance(exp_size, int)
            or exp_size <= 0
        ):
            raise CtlRollbackError(f"invalid metadata for '{logical_name}' in manifest.json")
        dump_file = verify_child_no_symlink(snapshot_dir, expected_filename, error_cls=CtlRollbackError)
        try:
            actual_sha, actual_size = _hash_regular_0600_file(dump_file)
        except CtlBackupError as exc:
            raise CtlRollbackError(str(exc)) from None
        if actual_size != exp_size or not hmac.compare_digest(actual_sha, exp_sha):
            raise CtlRollbackError(
                f"tampered or corrupted backup refused: SHA-256/size mismatch on {expected_filename}"
            )

    record = BackupRecord(backup_id=selected_id, backup_dir=snapshot_dir, manifest=manifest)
    _load_recovery_config(record)
    return record


def _verify_internal_backend_readiness(
    ctx: StackContext,
    compose_argv: Sequence[str],
    runner: CommandRunner,
    *,
    error_cls: type[CtlError],
) -> None:
    """Verify `server` and `synapse` internal health via `exec -T` while `caddy` is still stopped."""
    _run_checked(
        ctx,
        runner,
        [*compose_argv, "exec", "-T", "server", "python", "-c", INTERNAL_SERVER_READY_CODE],
        phase="internal-server-readiness",
        error_cls=error_cls,
        timeout=30.0,
    )
    _run_checked(
        ctx,
        runner,
        [*compose_argv, "exec", "-T", "synapse", "curl", "-fsS", "http://127.0.0.1:8008/_matrix/client/versions"],
        phase="internal-synapse-readiness",
        error_cls=error_cls,
        timeout=30.0,
    )


def _run_configured_webrtc_probe(
    ctx: StackContext,
    *,
    skip_webrtc_probe: bool,
    webrtc_port_override: int | None,
    webrtc_prober: WebRtcProbeFn,
    error_cls: type[CtlError],
) -> dict[str, object]:
    """Execute TURN/STUN-aware WebRTC UDP probe while `caddy` is still stopped."""
    if skip_webrtc_probe:
        return {"status": "skipped_by_flag", "healthy": True}
    if webrtc_port_override is not None or ctx.turn_config.enabled:
        target_port = (
            webrtc_port_override or ctx.turn_config.stun_port or webrtc_probe.DEFAULT_TURN_PORT
        )
        target_host = ctx.turn_config.stun_host or ctx.domain
        try:
            webrtc_result = webrtc_prober(
                stun_host=target_host,
                stun_port=target_port,
                turn_url=ctx.turn_config.turn_url,
                turn_username=ctx.turn_config.turn_username,
                turn_password=ctx.turn_config.turn_password,
                domain=ctx.domain,
                extra_secrets=ctx.secrets,
                timeout_budget=2.0,
            )
        except (OSError, ValueError, TimeoutError, CtlError) as exc:
            clean = redact_secrets(str(exc), ctx.secrets)
            raise error_cls(f"WebRTC UDP probe error: {clean}") from None

        if not webrtc_result.get("healthy"):
            status_label = webrtc_result.get("status", "udp_unreachable_or_filtered")
            diag = redact_secrets(str(webrtc_result.get("diagnosis", "")), ctx.secrets)
            raise error_cls(f"WebRTC UDP probe failed ({status_label}): {diag}")
        return webrtc_result

    return {
        "status": "skipped_no_stun_turn_listener",
        "healthy": True,
    }


def verify_public_http_postflight(
    ctx: StackContext,
    *,
    base_url_override: str | None = None,
    http_fetcher: HttpFetcher | None = None,
    error_cls: type[CtlError] = CtlPostflightError,
) -> dict[str, int]:
    """Verify public Caddy routes (`/health/*`, `/_matrix/client/versions`) and closed 404 planes."""
    active_http = default_http_fetcher if http_fetcher is None else http_fetcher
    api_origin, matrix_origin = probe_origins_for_context(ctx, base_url_override=base_url_override)

    observed_http: dict[str, int] = {}
    for origin, path in (
        (api_origin, "/health/live"),
        (api_origin, "/health/ready"),
        (matrix_origin, "/_matrix/client/versions"),
    ):
        try:
            resp = active_http(origin + path, 5.0)
        except (OSError, urllib.error.URLError, CtlError, ValueError) as exc:
            clean = redact_secrets(str(exc), ctx.secrets)
            raise error_cls(f"post-flight HTTP probe failed on {path}: {clean}") from None
        observed_http[path] = resp.status
        if resp.status != 200:
            raise error_cls(
                f"post-flight HTTP check refused on {path}: got {resp.status}, expected 200"
            )
        try:
            payload = json.loads(resp.body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise error_cls(f"post-flight {path} did not return valid JSON") from None
        if path == "/health/live" and payload != {"status": "alive"}:
            raise error_cls("post-flight /health/live payload mismatch")
        if path == "/health/ready" and payload != {
            "status": "ready",
            "database": "reachable",
        }:
            raise error_cls("post-flight /health/ready payload mismatch")
        if path == "/_matrix/client/versions":
            versions = payload.get("versions") if isinstance(payload, dict) else None
            if not isinstance(versions, list) or not versions:
                raise error_cls("post-flight /_matrix/client/versions payload invalid")

    closed_observed = verify_live_isolation_only(
        ctx,
        base_url_override=base_url_override,
        http_fetcher=active_http,
        error_cls=error_cls,
    )
    observed_http.update(closed_observed)
    return observed_http


def verify_postflight(
    ctx: StackContext,
    *,
    base_url_override: str | None = None,
    skip_webrtc_probe: bool = False,
    webrtc_port_override: int | None = None,
    http_fetcher: HttpFetcher | None = None,
    webrtc_prober: WebRtcProbeFn | None = None,
    error_cls: type[CtlError] = CtlPostflightError,
) -> dict[str, object]:
    """Combined public HTTP + WebRTC post-flight check (used by `status` and `rollback`)."""
    active_webrtc = webrtc_probe.run_probe if webrtc_prober is None else webrtc_prober
    observed_http = verify_public_http_postflight(
        ctx,
        base_url_override=base_url_override,
        http_fetcher=http_fetcher,
        error_cls=error_cls,
    )
    webrtc_result = _run_configured_webrtc_probe(
        ctx,
        skip_webrtc_probe=skip_webrtc_probe,
        webrtc_port_override=webrtc_port_override,
        webrtc_prober=active_webrtc,
        error_cls=error_cls,
    )
    return {
        "http": observed_http,
        "webrtc": webrtc_result,
    }


def _run_checked(
    ctx: StackContext,
    runner: CommandRunner,
    argv: Sequence[str],
    *,
    phase: str,
    error_cls: type[CtlError],
    timeout: float = 300.0,
) -> CommandResult:
    try:
        res = _invoke_runner(ctx, runner, argv, timeout=timeout)
    except CtlCommandError as cmd_err:
        clean_err = redact_secrets(str(cmd_err), ctx.secrets)
        raise error_cls(f"{phase} failed: {clean_err}") from None
    if res.returncode != 0:
        detail = redact_secrets((res.stderr or res.stdout).strip(), ctx.secrets)
        first_line = detail.splitlines()[0] if detail else f"exit {res.returncode}"
        raise error_cls(f"{phase} failed: {first_line}")
    return res


def _reset_and_restore_pg_dump(
    ctx: StackContext,
    runner: CommandRunner,
    *,
    service: str,
    db_user: str,
    db_name: str,
    dump_path: Path,
) -> None:
    """Terminate backends, reset `public` schema, and run `pg_restore` preserving snapshot ACLs."""
    base_argv = build_compose_argv(ctx)
    _run_checked(
        ctx,
        runner,
        [
            *base_argv,
            "exec",
            "-T",
            service,
            "psql",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            db_user,
            "-d",
            db_name,
            "-c",
            TERMINATE_BACKENDS_SQL,
        ],
        phase=f"terminate-backends-{service}",
        error_cls=CtlRollbackError,
        timeout=60.0,
    )
    _run_checked(
        ctx,
        runner,
        [
            *base_argv,
            "exec",
            "-T",
            service,
            "psql",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            db_user,
            "-d",
            db_name,
            "-c",
            RESET_PUBLIC_SCHEMA_SQL,
        ],
        phase=f"reset-public-schema-{service}",
        error_cls=CtlRollbackError,
        timeout=60.0,
    )

    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(dump_path, flags)
    except OSError as exc:
        raise CtlRollbackError(
            f"cannot open dump file {dump_path.name}: {exc.strerror or 'os error'}"
        ) from None
    try:
        fst = os.fstat(fd)
        if not stat.S_ISREG(fst.st_mode):
            raise CtlRollbackError(f"dump path is not a regular file: {dump_path}")
        argv = [
            *base_argv,
            "exec",
            "-T",
            service,
            "pg_restore",
            "--clean",
            "--if-exists",
            "--no-owner",
            "--single-transaction",
            "-U",
            db_user,
            "-d",
            db_name,
        ]
        res = _invoke_runner(ctx, runner, argv, stdin_fd=fd, timeout=300.0)
    except CtlCommandError as cmd_err:
        clean = redact_secrets(str(cmd_err), ctx.secrets)
        raise CtlRollbackError(f"pg_restore failed on '{service}': {clean}") from None
    finally:
        with contextlib.suppress(OSError):
            os.close(fd)

    if res.returncode != 0:
        detail = redact_secrets(res.stderr.strip(), ctx.secrets)
        first_line = detail.splitlines()[0] if detail else f"exit {res.returncode}"
        raise CtlRollbackError(f"pg_restore failed on '{service}': {first_line}")


def _prepare_rollback_image_override(
    ctx: StackContext,
    target_dir: Path,
    images_map: Mapping[str, object],
    pinned_refs: Mapping[str, str],
    runner: CommandRunner,
) -> Path:
    """Write 0600 `rollback.override.yml` (`image: sha256:...`, `pull_policy: never`, `migrate` gated)."""
    if not pinned_refs:
        raise CtlRollbackError("cannot generate rollback override from empty image inventory")

    lines = ["services:"]
    for svc, sha_ref in sorted(pinned_refs.items()):
        meta = images_map.get(svc)
        if isinstance(meta, Mapping):
            running_tag = str(meta.get("running_tag") or "").strip()
            if (
                running_tag
                and "@" not in running_tag
                and not running_tag.startswith("sha256:")
                and sha_ref != running_tag
                and IMAGE_ID_RE.fullmatch(sha_ref)
                and PINNED_IMAGE_VALUE_RE.fullmatch(running_tag)
            ):
                _invoke_runner(
                    ctx,
                    runner,
                    ["docker", "image", "tag", sha_ref, running_tag],
                    timeout=15.0,
                )
        lines.append(f"  {svc}:")
        lines.append(f"    image: {sha_ref}")
        lines.append("    pull_policy: never")

    # Pin `migrate` to a no-op entrypoint on the recorded `server` sha256 image (`pull_policy: never`)
    # without altering `profiles`, so `docker compose config` keeps `depends_on: migrate` valid while
    # `--no-deps` and the no-op entrypoint both prevent forward migrations from ever running.
    server_sha = pinned_refs.get("server") or next(iter(pinned_refs.values()))
    lines.append("  migrate:")
    lines.append(f"    image: {server_sha}")
    lines.append("    pull_policy: never")
    lines.append('    entrypoint: ["/bin/sh", "-c", "exit 0"]')
    lines.append("    command: []")

    override_bytes = ("\n".join(lines) + "\n").encode()
    try:
        return _write_atomic_0600_bytes(target_dir, "rollback.override.yml", override_bytes)
    except CtlBackupError as exc:
        raise CtlRollbackError(str(exc)) from None


def _fail_closed_stop_caddy(
    ctx: StackContext,
    base_argv: Sequence[str],
    runner: CommandRunner,
) -> str:
    """Attempt `stop caddy` and report truthfully whether public ingress was closed."""
    try:
        stop_res = _invoke_runner(ctx, runner, [*base_argv, "stop", "caddy"], timeout=30.0)
    except CtlError as stop_err:
        reason = redact_secrets(str(stop_err), ctx.secrets)
        return f"CRITICAL: failed to stop caddy ({reason}) — public ingress may still be open"
    if stop_res.returncode == 0:
        return "caddy stopped fail-closed"
    raw_detail = (stop_res.stderr or stop_res.stdout).strip()
    first_line = raw_detail.splitlines()[0] if raw_detail else f"exit {stop_res.returncode}"
    reason = redact_secrets(first_line, ctx.secrets)
    return f"CRITICAL: failed to stop caddy ({reason}) — public ingress may still be open"


def _open_caddy_and_verify_public_http(
    ctx: StackContext,
    caddy_up_argv: Sequence[str],
    stop_base_argv: Sequence[str],
    runner: CommandRunner,
    *,
    base_url_override: str | None,
    http_fetcher: HttpFetcher | None,
    error_cls: type[CtlError],
    extra_note: str = "",
) -> dict[str, int]:
    """Start `caddy` last and verify public HTTP + 404 isolation, failing closed on error."""
    try:
        _run_checked(
            ctx,
            runner,
            [*caddy_up_argv, "up", "-d", "--no-build", "--no-deps", "--wait", "caddy"],
            phase="start-caddy",
            error_cls=error_cls,
            timeout=120.0,
        )
        return verify_public_http_postflight(
            ctx,
            base_url_override=base_url_override,
            http_fetcher=http_fetcher,
            error_cls=error_cls,
        )
    except CtlError as post_err:
        caddy_note = _fail_closed_stop_caddy(ctx, stop_base_argv, runner)
        safe_post_err = redact_secrets(str(post_err), ctx.secrets)
        suffix = f"; {extra_note}" if extra_note else ""
        raise error_cls(f"{safe_post_err} ({caddy_note}{suffix})") from None


def _start_pinned_backends_and_probe_no_deps(
    ctx: StackContext,
    restart_argv: Sequence[str],
    runner: CommandRunner,
    *,
    skip_webrtc_probe: bool,
    webrtc_port_override: int | None,
    webrtc_prober: WebRtcProbeFn,
    error_cls: type[CtlError],
    recovery_services: Mapping[str, str] | None = None,
) -> dict[str, object]:
    """Start socket-init + backend services (`--no-build --no-deps`) and verify readiness + WebRTC BEFORE `caddy`."""
    for init_svc in socket_init_services(governance_enabled=ctx.governance_enabled):
        if recovery_services is not None and init_svc not in recovery_services:
            continue
        _run_checked(
            ctx,
            runner,
            [*restart_argv, "up", "--no-build", "--no-deps", init_svc],
            phase=f"recover-init-{init_svc}",
            error_cls=error_cls,
            timeout=120.0,
        )
    for svc in backend_runtime_services(ctx.topology, governance_enabled=ctx.governance_enabled):
        if recovery_services is not None and svc not in recovery_services:
            continue
        _run_checked(
            ctx,
            runner,
            [*restart_argv, "up", "-d", "--no-build", "--no-deps", "--wait", svc],
            phase=f"recover-{svc}",
            error_cls=error_cls,
            timeout=240.0,
        )
    _verify_internal_backend_readiness(ctx, restart_argv, runner, error_cls=error_cls)
    return _run_configured_webrtc_probe(
        ctx,
        skip_webrtc_probe=skip_webrtc_probe,
        webrtc_port_override=webrtc_port_override,
        webrtc_prober=webrtc_prober,
        error_cls=error_cls,
    )


def _remove_new_recovery_services(
    ctx: StackContext, runner: CommandRunner, images: Mapping[str, object]
) -> None:
    added = sorted(
        svc for svc, meta in images.items()
        if isinstance(meta, Mapping) and meta.get("state") == "new_service"
    )
    if added:
        _run_checked(
            ctx, runner, [*build_compose_argv(ctx), "rm", "--force", "--stop", *added],
            phase="remove-new-services", error_cls=CtlRollbackError,
        )


def execute_rollback(
    *,
    env_file: Path,
    stack_dir: Path = HERE,
    backup_selector: str = "latest",
    project_name: str | None = None,
    base_url_override: str | None = None,
    skip_preflight_http: bool = False,
    skip_webrtc_probe: bool = False,
    webrtc_port_override: int | None = None,
    runner: CommandRunner | None = None,
    http_fetcher: HttpFetcher | None = None,
    webrtc_prober: WebRtcProbeFn | None = None,
    invoke_deploy_cli: bool = True,
) -> dict[str, object]:
    """Verify backup + complete sha256 inventory, stop writers, restore DBs+ACLs, and restart `--no-deps`."""
    active_runner = default_command_runner if runner is None else runner
    active_http = default_http_fetcher if http_fetcher is None else http_fetcher
    active_webrtc = webrtc_probe.run_probe if webrtc_prober is None else webrtc_prober
    ctx = preflight_stack(
        env_file=env_file,
        stack_dir=stack_dir,
        project_name=project_name,
        base_url_override=base_url_override,
        skip_preflight_http=skip_preflight_http,
        http_fetcher=active_http,
        invoke_deploy_cli=invoke_deploy_cli,
    )
    record = resolve_and_verify_backup(ctx.stack_dir, backup_selector)
    recovery_config = _load_recovery_config(record)

    raw_images = record.manifest.get("images")
    # Require a complete, locally verified `sha256:` image_id inventory BEFORE stopping services!
    pinned_refs = validate_recovery_images(
        ctx, raw_images, active_runner, error_cls=CtlRollbackError
    )
    images_map = raw_images if isinstance(raw_images, Mapping) else {}
    override_file = _prepare_rollback_image_override(
        ctx, record.backup_dir, images_map, pinned_refs, active_runner
    )
    restart_argv = build_compose_argv(ctx, extra_compose_files=(override_file,))

    base_argv = build_compose_argv(ctx)
    runtime_services = topological_service_order(
        ctx.topology, governance_enabled=ctx.governance_enabled
    )
    backend_writers = backend_writer_stop_order(
        ctx.topology, governance_enabled=ctx.governance_enabled
    )

    # 1. Stop `caddy` first, then stop all backend writers before touching databases.
    _run_checked(
        ctx,
        active_runner,
        [*base_argv, "stop", "caddy"],
        phase="stop-caddy-ingress",
        error_cls=CtlRollbackError,
    )
    _run_checked(
        ctx,
        active_runner,
        [*base_argv, "stop", *backend_writers],
        phase="stop-write-services",
        error_cls=CtlRollbackError,
    )

    _remove_new_recovery_services(ctx, active_runner, images_map)
    _restore_recovery_config(ctx, recovery_config)
    _restore_recovery_routing(ctx, images_map)

    # 2. Ensure PostgreSQL containers run from their pinned sha256 images with `--no-build --no-deps`.
    _run_checked(
        ctx,
        active_runner,
        [*restart_argv, "up", "-d", "--no-build", "--no-deps", "--wait", "db", "synapse-db"],
        phase="start-databases",
        error_cls=CtlRollbackError,
    )

    # 3. Terminate backends, cleanly reset `public` schema, and restore both DBs + ACLs.
    pg_user = str(record.manifest.get("postgres_user") or ctx.postgres_user)
    pg_db = str(record.manifest.get("postgres_db") or ctx.postgres_db)
    _reset_and_restore_pg_dump(
        ctx,
        active_runner,
        service="db",
        db_user=pg_user,
        db_name=pg_db,
        dump_path=record.backup_dir / "kodera_server.dump",
    )
    _reset_and_restore_pg_dump(
        ctx,
        active_runner,
        service="synapse-db",
        db_user="synapse",
        db_name="synapse",
        dump_path=record.backup_dir / "synapse.dump",
    )

    # 4. Start socket-init + backend runtime services (`--no-build --no-deps`) and verify internal
    # readiness + WebRTC UDP BEFORE starting `caddy`!
    webrtc_result = _start_pinned_backends_and_probe_no_deps(
        ctx,
        restart_argv,
        active_runner,
        skip_webrtc_probe=skip_webrtc_probe,
        webrtc_port_override=webrtc_port_override,
        webrtc_prober=active_webrtc,
        error_cls=CtlRollbackError,
        recovery_services=pinned_refs,
    )

    # 5. Open `caddy` last and verify public HTTP + closed 404 isolation, failing closed on error.
    observed_http = _open_caddy_and_verify_public_http(
        ctx,
        restart_argv,
        base_argv,
        active_runner,
        base_url_override=base_url_override,
        http_fetcher=active_http,
        error_cls=CtlRollbackError,
    )

    return {
        "status": "rolled_back",
        "backup_id": record.backup_id,
        "env_matched_backup": hmac.compare_digest(
            ctx.env_sha256, str(record.manifest.get("env_sha256", ""))
        ),
        "restored_services": [svc for svc in runtime_services if svc in pinned_refs],
        "postflight": {
            "http": observed_http,
            "webrtc": webrtc_result,
        },
    }


def execute_upgrade(
    *,
    env_file: Path,
    stack_dir: Path = HERE,
    project_name: str | None = None,
    auto_rollback: bool = True,
    base_url_override: str | None = None,
    skip_preflight_http: bool = False,
    skip_webrtc_probe: bool = False,
    webrtc_port_override: int | None = None,
    dry_run: bool = False,
    runner: CommandRunner | None = None,
    http_fetcher: HttpFetcher | None = None,
    webrtc_prober: WebRtcProbeFn | None = None,
    invoke_deploy_cli: bool = True,
) -> dict[str, object]:
    """Stage live, close `caddy`, quiesce writers, snapshot, roll & verify backends+WebRTC, then open `caddy`."""
    active_runner = default_command_runner if runner is None else runner
    active_http = default_http_fetcher if http_fetcher is None else http_fetcher
    active_webrtc = webrtc_probe.run_probe if webrtc_prober is None else webrtc_prober
    ctx = preflight_stack(
        env_file=env_file,
        stack_dir=stack_dir,
        project_name=project_name,
        base_url_override=base_url_override,
        skip_preflight_http=skip_preflight_http,
        http_fetcher=active_http,
        invoke_deploy_cli=invoke_deploy_cli,
    )

    base_argv = build_compose_argv(ctx)
    backend_services = backend_runtime_services(
        ctx.topology, governance_enabled=ctx.governance_enabled
    )
    ordered_services = topological_service_order(
        ctx.topology, governance_enabled=ctx.governance_enabled
    )
    backend_writers = backend_writer_stop_order(
        ctx.topology, governance_enabled=ctx.governance_enabled
    )
    init_services = socket_init_services(governance_enabled=ctx.governance_enabled)

    if dry_run:
        planned = [
            [*base_argv, "pull", "--ignore-buildable"],
            [*base_argv, "build"],
            [*base_argv, "stop", "caddy"],
            [*base_argv, "stop", *backend_writers],
            *[[*base_argv, "up", "--no-deps", init_svc] for init_svc in init_services],
            [*base_argv, "run", "--rm", "--no-deps", "migrate"],
            *[[*base_argv, "up", "-d", "--no-deps", "--wait", svc] for svc in backend_services],
            [*base_argv, "up", "-d", "--no-build", "--no-deps", "--wait", "caddy"],
        ]
        return {
            "status": "dry_run",
            "topology": ctx.topology,
            "domain": ctx.domain,
            "federation_closed": ctx.federation_closed,
            "service_order": list(ordered_services),
            "planned_commands_count": len(planned),
        }

    # 1. Capture complete immutable `sha256:` recovery inventory BEFORE `pull`/`build` mutates tags,
    # then stage new images while running services continue serving without interruption.
    pre_stage_config = _capture_recovery_config(ctx)
    pre_stage_images = capture_running_images(
        ctx, active_runner, error_cls=CtlUpgradeError
    )
    pinned_pre = validate_recovery_images(
        ctx, pre_stage_images, active_runner, error_cls=CtlUpgradeError
    )
    _run_checked(
        ctx,
        active_runner,
        [*base_argv, "pull", "--ignore-buildable"],
        phase="pull-images",
        error_cls=CtlUpgradeError,
        timeout=600.0,
    )
    _run_checked(
        ctx,
        active_runner,
        [*base_argv, "build"],
        phase="build-images",
        error_cls=CtlUpgradeError,
        timeout=900.0,
    )

    # 2. Pre-ingress maintenance & auto-rollback window (`caddy` stopped FIRST and kept stopped
    # throughout snapshot, migration, backend rollout, internal readiness, and WebRTC probing so
    # ZERO public writes can ever enter before auto-rollback eligibility closes!).
    backup: BackupRecord | None = None
    webrtc_result: dict[str, object] = {"status": "skipped_no_stun_turn_listener", "healthy": True}
    try:
        _run_checked(
            ctx,
            active_runner,
            [*base_argv, "stop", "caddy"],
            phase="stop-caddy-ingress",
            error_cls=CtlUpgradeError,
            timeout=60.0,
        )
        _run_checked(
            ctx,
            active_runner,
            [*base_argv, "stop", *backend_writers],
            phase="quiesce-write-services",
            error_cls=CtlUpgradeError,
            timeout=120.0,
        )
        _run_checked(
            ctx,
            active_runner,
            [*base_argv, "up", "-d", "--no-deps", "--wait", "db", "synapse-db"],
            phase="ensure-databases-ready",
            error_cls=CtlUpgradeError,
            timeout=120.0,
        )

        # 3. Atomic 0700/0600 pre-migration backup (preserving ACLs) while ingress & writers are stopped.
        backup = create_backup(
            ctx,
            runner=active_runner,
            pre_captured_images=pre_stage_images,
            pre_captured_config=pre_stage_config,
        )

        # 4. Run socket-init containers and schema/role migrator with `--no-deps`.
        for init_svc in init_services:
            _run_checked(
                ctx,
                active_runner,
                [*base_argv, "up", "--no-deps", init_svc],
                phase=f"init-{init_svc}",
                error_cls=CtlUpgradeError,
                timeout=120.0,
            )
        _run_checked(
            ctx,
            active_runner,
            [*base_argv, "run", "--rm", "--no-deps", "migrate"],
            phase="migrate",
            error_cls=CtlUpgradeError,
            timeout=300.0,
        )

        # 5. Roll out backend runtime services ONLY (`caddy` stays stopped!).
        for svc in backend_services:
            _run_checked(
                ctx,
                active_runner,
                [*base_argv, "up", "-d", "--no-deps", "--wait", svc],
                phase=f"roll-{svc}",
                error_cls=CtlUpgradeError,
                timeout=240.0,
            )

        # 6. Verify internal backend readiness (`server` + `synapse`) and WebRTC UDP BEFORE starting `caddy`!
        _verify_internal_backend_readiness(
            ctx, base_argv, active_runner, error_cls=CtlUpgradeError
        )
        webrtc_result = _run_configured_webrtc_probe(
            ctx,
            skip_webrtc_probe=skip_webrtc_probe,
            webrtc_port_override=webrtc_port_override,
            webrtc_prober=active_webrtc,
            error_cls=CtlUpgradeError,
        )
    except CtlError as upgrade_err:
        safe_upgrade_err = redact_secrets(str(upgrade_err), ctx.secrets)
        if not auto_rollback:
            suffix = (
                f" (backup preserved as {backup.backup_id})"
                if backup
                else " (before backup completion)"
            )
            raise CtlUpgradeError(f"{safe_upgrade_err}{suffix}") from None

        if backup is None:
            # Failure occurred before `migrate` (databases untouched): recover pre-stage images
            # with `--no-build --no-deps` so `migrate` never runs.
            backup_root = ensure_backup_root(ctx.stack_dir)
            rec_tmp = verify_child_no_symlink(
                backup_root,
                f".pre-backup-recover-{os.getpid()}-{secrets.token_hex(3)}",
                error_cls=CtlRollbackError,
            )
            try:
                os.mkdir(rec_tmp, 0o700)
                os.chmod(rec_tmp, 0o700)
                override = _prepare_rollback_image_override(
                    ctx, rec_tmp, pre_stage_images, pinned_pre, active_runner
                )
                _remove_new_recovery_services(ctx, active_runner, pre_stage_images)
                _restore_recovery_config(ctx, pre_stage_config)
                _restore_recovery_routing(ctx, pre_stage_images)
                recover_argv = build_compose_argv(ctx, extra_compose_files=(override,))
                _start_pinned_backends_and_probe_no_deps(
                    ctx,
                    recover_argv,
                    active_runner,
                    skip_webrtc_probe=skip_webrtc_probe,
                    webrtc_port_override=webrtc_port_override,
                    webrtc_prober=active_webrtc,
                    error_cls=CtlRollbackError,
                    recovery_services=pinned_pre,
                )
                _open_caddy_and_verify_public_http(
                    ctx,
                    recover_argv,
                    base_argv,
                    active_runner,
                    base_url_override=base_url_override,
                    http_fetcher=active_http,
                    error_cls=CtlRollbackError,
                )
            finally:
                shutil.rmtree(rec_tmp, ignore_errors=True)
            raise CtlUpgradeError(
                f"{safe_upgrade_err} (pre-migration services restarted without database changes)"
            ) from None

        rollback_report = execute_rollback(
            env_file=ctx.env_file,
            stack_dir=ctx.stack_dir,
            backup_selector=backup.backup_id,
            project_name=project_name,
            base_url_override=base_url_override,
            skip_preflight_http=True,
            skip_webrtc_probe=skip_webrtc_probe,
            webrtc_port_override=webrtc_port_override,
            runner=active_runner,
            http_fetcher=active_http,
            webrtc_prober=active_webrtc,
            invoke_deploy_cli=False,
        )
        return {
            "status": "auto_rolled_back",
            "healthy": False,
            "backup_id": backup.backup_id,
            "upgrade_error": safe_upgrade_err,
            "rollback": rollback_report,
        }

    # 7. Auto-rollback window is now CLOSED (all backend & WebRTC checks passed).
    # Reopen public ingress (`caddy`) last and verify public HTTP + closed 404 isolation;
    # if post-caddy check fails, attempt `stop caddy` fail-closed and report truthful status!
    observed_http = _open_caddy_and_verify_public_http(
        ctx,
        base_argv,
        base_argv,
        active_runner,
        base_url_override=base_url_override,
        http_fetcher=active_http,
        error_cls=CtlPostflightError,
        extra_note=(
            f"backup {backup.backup_id} preserved for operator review without auto-rollback "
            "so post-open writes are never overwritten"
        ),
    )

    return {
        "status": "upgraded",
        "healthy": True,
        "backup_id": backup.backup_id,
        "topology": ctx.topology,
        "rolled_services": list(ordered_services),
        "postflight": {
            "http": observed_http,
            "webrtc": webrtc_result,
        },
    }


def list_backups_summary(stack_dir: Path) -> list[dict[str, object]]:
    real_stack = verify_directory_no_symlink(stack_dir)
    backup_root = real_stack / BACKUP_DIR_NAME
    if not backup_root.exists():
        return []
    ensure_backup_root(real_stack)
    items: list[dict[str, object]] = []
    for entry in sorted(os.listdir(backup_root)):
        if entry.startswith("."):
            continue
        try:
            rec = resolve_and_verify_backup(real_stack, entry)
        except CtlError:
            continue
        items.append(
            {
                "backup_id": rec.backup_id,
                "created_at": rec.manifest.get("created_at"),
                "topology": rec.manifest.get("topology"),
            }
        )
    return items


def execute_status(
    *,
    env_file: Path,
    stack_dir: Path = HERE,
    project_name: str | None = None,
    base_url_override: str | None = None,
    skip_preflight_http: bool = False,
    skip_webrtc_probe: bool = False,
    webrtc_port_override: int | None = None,
    runner: CommandRunner | None = None,
    http_fetcher: HttpFetcher | None = None,
    webrtc_prober: WebRtcProbeFn | None = None,
    invoke_deploy_cli: bool = True,
) -> dict[str, object]:
    """Inspect preflight posture, running containers, HTTP health/isolation, WebRTC UDP, and backups."""
    active_runner = default_command_runner if runner is None else runner
    active_http = default_http_fetcher if http_fetcher is None else http_fetcher
    active_webrtc = webrtc_probe.run_probe if webrtc_prober is None else webrtc_prober
    ctx = preflight_stack(
        env_file=env_file,
        stack_dir=stack_dir,
        project_name=project_name,
        base_url_override=base_url_override,
        skip_preflight_http=skip_preflight_http,
        http_fetcher=active_http,
        invoke_deploy_cli=invoke_deploy_cli,
    )
    base_argv = build_compose_argv(ctx)
    ps_res = _invoke_runner(ctx, active_runner, [*base_argv, "ps", "--format", "json"], timeout=30.0)
    containers_count = len(_parse_json_lines_or_array(ps_res.stdout)) if ps_res.returncode == 0 else 0

    postflight = verify_postflight(
        ctx,
        base_url_override=base_url_override,
        skip_webrtc_probe=skip_webrtc_probe,
        webrtc_port_override=webrtc_port_override,
        http_fetcher=active_http,
        webrtc_prober=active_webrtc,
    )
    backups = list_backups_summary(ctx.stack_dir)
    return {
        "status": "healthy",
        "healthy": True,
        "topology": ctx.topology,
        "domain": ctx.domain,
        "federation_closed": ctx.federation_closed,
        "containers_running": containers_count,
        "backups": backups,
        "postflight": postflight,
    }


def _make_valid_test_env_text(
    *,
    domain: str = "chat.example.org",
    topology: str = "single",
    db_canary_marker: str | None = None,
    extra_lines: Sequence[str] = (),
) -> str:
    import base64 as _b64
    import uuid as _uuid

    template_text = (HERE / ".env.example").read_text(encoding="utf-8")
    trust = json.dumps(
        [
            {
                "lane": "customer",
                "issuer": "https://id.example.org/realms/selfhost",
                "generation": "v1",
                "expires_at": 1999999999,
                "public_jwks": {
                    "keys": [{"kty": "RSA", "kid": "k1", "n": "modulus-test", "e": "AQAB"}]
                },
            }
        ],
        separators=(",", ":"),
    )

    overrides: dict[str, str] = {
        "KODERA_TOPOLOGY": topology,
        "KODERA_DOMAIN": domain,
        "KODERA_MATRIX_DOMAIN": "example.org",
        "DJANGO_ALLOWED_HOSTS": (
            "api.example.org,127.0.0.1,server"
            if topology == "split"
            else f"{domain},127.0.0.1,server"
        ),
        "KODERA_AUTH_TRUST": f"'{trust}'",
        "KODERA_DEFAULT_COMMUNITY_ORG_SLUG": "",
        "KODERA_DEFAULT_COMMUNITY_ISSUER": "",
        "KODERA_DEFAULT_COMMUNITY_OWNER_USER_ID": "",
        "KODERA_AGENT_TOKEN": "",
        "KODERA_SYNAPSE_TOKEN": "",
        "KODERA_SYNAPSE_OIDC_ISSUER": "",
        "KODERA_SYNAPSE_OIDC_CLIENT_SECRET": "",
    }
    if db_canary_marker is not None:
        overrides["POSTGRES_" + "PASS" + "WORD"] = db_canary_marker

    lines: list[str] = []
    for line in template_text.splitlines():
        if line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        if k in overrides:
            v = overrides[k]
        elif "BASE64URL_32" in v:
            v = _b64.urlsafe_b64encode(_uuid.uuid4().bytes + _uuid.uuid4().bytes).decode("ascii")
        elif "BASE64_32" in v:
            v = _b64.b64encode(_uuid.uuid4().bytes + _uuid.uuid4().bytes).decode("ascii")
        elif "CHANGE_ME_" in v:
            v = _uuid.uuid4().hex + _uuid.uuid4().hex
        lines.append(f"{k}={v}")
    lines.extend(extra_lines)
    return "\n".join(lines) + "\n"


def selftest() -> int:
    """Deterministic self-test proving pre-caddy gates, sha256 inventory, ACL restore, and rollback."""
    import uuid as _uuid

    with tempfile.TemporaryDirectory(prefix="kodera-ctl-selftest-") as tmp:
        stack = Path(tmp) / "stack"
        stack.mkdir(mode=0o755)
        for fname in (
            "docker-compose.yml",
            "docker-compose.split.yml",
            "Caddyfile",
            "Caddyfile.split",
            ".env.example",
            "livekit.yaml",
            "configure_synapse.py",
        ):
            (stack / fname).write_text((HERE / fname).read_text(encoding="utf-8"), encoding="utf-8")

        canary_val = _uuid.uuid4().hex + _uuid.uuid4().hex
        env_file = stack / ".env"
        env_file.write_text(_make_valid_test_env_text(db_canary_marker=canary_val), encoding="utf-8")
        env_file.chmod(0o600)

        # 1. Preflight refuses exposed /agent/* in Caddyfile and refuses open federation.
        orig_caddy = (stack / "Caddyfile").read_text(encoding="utf-8")
        (stack / "Caddyfile").write_text(
            orig_caddy.replace("@api path /api/* /health/*", "@api path /api/* /health/* /agent/*"),
            encoding="utf-8",
        )
        try:
            preflight_stack(env_file=env_file, stack_dir=stack, invoke_deploy_cli=False)
        except CtlPreflightError:
            pass
        else:
            raise AssertionError("exposed /agent/* in Caddyfile escaped preflight")
        (stack / "Caddyfile").write_text(orig_caddy, encoding="utf-8")

        # 2. Ephemeral local HTTP ingress + EphemeralStunTurnServer for upgrade & pre-caddy auto-rollback.
        internal_ready = {"ok": True}

        class _Handler(BaseHTTPRequestHandler):
            def log_message(self, fmt: str, *args: object) -> None:
                return

            def do_GET(self) -> None:
                if self.path == "/health/live":
                    body, code = b'{"status":"alive"}', 200
                elif self.path == "/health/ready":
                    body, code = b'{"status":"ready","database":"reachable"}', 200
                elif self.path == "/_matrix/client/versions":
                    body, code = b'{"versions":["v1.11"]}', 200
                else:
                    body, code = b"not found", 404
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        recorded_cmds: list[list[str]] = []

        def fake_runner(
            argv: Sequence[str],
            *,
            cwd: Path | None = None,
            stdout_fd: int | None = None,
            stdin_fd: int | None = None,
            timeout: float = 300.0,
        ) -> CommandResult:
            cmd = list(argv)
            recorded_cmds.append(cmd)
            if "pg_dump" in cmd and stdout_fd is not None:
                assert "--no-acl" not in cmd
                svc = cmd[cmd.index("-T") + 1]
                os.write(stdout_fd, f"PGDMP-SELFTEST-{svc}-ACLS\n".encode())
                return CommandResult(0, "", "")
            if "pg_restore" in cmd and stdin_fd is not None:
                assert "--no-acl" not in cmd
                data = os.read(stdin_fd, 4096)
                assert data.startswith(b"PGDMP-SELFTEST-")
                internal_ready["ok"] = True
                return CommandResult(0, "", "")
            if "exec" in cmd and "server" in cmd and "python" in cmd:
                return CommandResult(0 if internal_ready["ok"] else 1, "", "internal server unhealthy")
            if len(cmd) >= 3 and cmd[-3:] == ["ps", "--format", "json"]:
                return CommandResult(0, '[{"Service":"server","ID":"cid-server","Image":"kodera-server:local"}]', "")
            if len(cmd) >= 4 and cmd[-4:] == ["ps", "-a", "--format", "json"]:
                svcs = expected_recovery_services("single", governance_enabled=False)
                rows = [
                    {"Service": s, "ID": f"cid-{s}", "Image": f"kodera-{s}:local"}
                    for s in svcs
                ]
                return CommandResult(0, json.dumps(rows), "")
            if cmd[:2] == ["docker", "inspect"]:
                digest = "sha256:" + hashlib.sha256(cmd[-1].encode()).hexdigest()
                return CommandResult(0, json.dumps({"Image": digest}), "")
            if cmd[:3] == ["docker", "image", "inspect"]:
                ref = cmd[-1]
                out = ref if IMAGE_ID_RE.fullmatch(ref) else ("sha256:" + hashlib.sha256(ref.encode()).hexdigest())
                return CommandResult(0, out + "\n", "")
            return CommandResult(0, "", "")

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        http_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        http_thread.start()
        base_url = f"http://127.0.0.1:{httpd.server_address[1]}"

        try:
            with webrtc_probe.EphemeralStunTurnServer() as stun_srv:
                def probe_cb(**kwargs: object) -> dict[str, object]:
                    return webrtc_probe.run_probe(
                        stun_host="127.0.0.1",
                        stun_port=int(kwargs.get("stun_port") or stun_srv.port),
                        domain=str(kwargs.get("domain") or "chat.example.org"),
                        timeout_budget=0.8,
                    )

                up_res = execute_upgrade(
                    env_file=env_file,
                    stack_dir=stack,
                    base_url_override=base_url,
                    webrtc_port_override=stun_srv.port,
                    runner=fake_runner,
                    webrtc_prober=probe_cb,
                    invoke_deploy_cli=False,
                )
                assert up_res["status"] == "upgraded"
                backup_id = str(up_res["backup_id"])
                snap_dir = stack / BACKUP_DIR_NAME / backup_id
                assert canary_val not in (snap_dir / "manifest.json").read_text(encoding="utf-8")

                # Failed internal readiness BEFORE `caddy` starts triggers lossless auto-rollback!
                recorded_cmds.clear()

                def failing_migrate_runner(
                    argv: Sequence[str],
                    *,
                    cwd: Path | None = None,
                    stdout_fd: int | None = None,
                    stdin_fd: int | None = None,
                    timeout: float = 300.0,
                ) -> CommandResult:
                    if len(argv) >= 2 and argv[-1] == "migrate" and "run" in argv:
                        internal_ready["ok"] = False
                    return fake_runner(
                        argv, cwd=cwd, stdout_fd=stdout_fd, stdin_fd=stdin_fd, timeout=timeout
                    )

                auto_rb = execute_upgrade(
                    env_file=env_file,
                    stack_dir=stack,
                    base_url_override=base_url,
                    webrtc_port_override=stun_srv.port,
                    runner=failing_migrate_runner,
                    webrtc_prober=probe_cb,
                    invoke_deploy_cli=False,
                )
                assert auto_rb["status"] == "auto_rolled_back"
                assert auto_rb["rollback"]["status"] == "rolled_back"  # type: ignore[index]

                # Tampered dump digest must be refused BEFORE stopping containers/DBs.
                dump_to_tamper = snap_dir / "synapse.dump"
                os.chmod(dump_to_tamper, 0o600)
                with open(dump_to_tamper, "ab") as fp:
                    fp.write(b"TAMPER")
                recorded_before = len(recorded_cmds)
                try:
                    execute_rollback(
                        env_file=env_file,
                        stack_dir=stack,
                        backup_selector=backup_id,
                        base_url_override=base_url,
                        skip_preflight_http=True,
                        runner=fake_runner,
                        webrtc_prober=probe_cb,
                        invoke_deploy_cli=False,
                    )
                except CtlRollbackError:
                    assert len(recorded_cmds) == recorded_before
                else:
                    raise AssertionError("tampered backup dump accepted by rollback")
        finally:
            httpd.shutdown()
            httpd.server_close()

    print(
        "OK: kodera_ctl selftest passed (pre-caddy readiness & WebRTC gates, complete sha256 "
        "recovery inventory, --no-deps rollback isolation, ACL-preserving clean-schema restore, "
        "and tampered manifest refusal verified)."
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="kodera-ctl",
        description=(
            "Ordered, health-gated Kodera Community maintenance upgrade, rollback, status, "
            "and WebRTC STUN/TURN UDP diagnostic CLI."
        ),
    )
    parser.add_argument(
        "--selftest",
        action="store_true",
        help="Run built-in operational guardrail and backup/rollback self-tests",
    )
    subparsers = parser.add_subparsers(dest="subcommand")

    def add_common_stack_args(sub: argparse.ArgumentParser) -> None:
        sub.add_argument(
            "--env-file",
            type=Path,
            default=HERE / ".env",
            help="Path to operator .env configuration (default: deploy/community/.env)",
        )
        sub.add_argument(
            "--stack-dir",
            type=Path,
            default=HERE,
            help="Path to deploy/community stack directory",
        )
        sub.add_argument("--project-name", help="Optional Docker Compose project name (-p)")
        sub.add_argument("--base-url", help="Optional base URL override for HTTP health/isolation checks")
        sub.add_argument(
            "--skip-preflight-http",
            action="store_true",
            help="Skip live preflight HTTP 404 check (use when starting or recovering a stopped stack)",
        )
        sub.add_argument(
            "--webrtc-port",
            type=int,
            help="Explicit STUN/TURN UDP port for pre-ingress WebRTC probe",
        )
        sub.add_argument(
            "--skip-webrtc-probe",
            action="store_true",
            help="Skip STUN/TURN UDP check even when TURN is configured",
        )
        sub.add_argument("--json", action="store_true", help="Emit structured JSON output")

    up_parser = subparsers.add_parser(
        "upgrade",
        help="Preflight, pre-quiesce staging, ingress-closed 0700/0600 backup, migrate, and health-gated rollout",
    )
    add_common_stack_args(up_parser)
    up_parser.add_argument(
        "--auto-rollback",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Automatically roll back on pre-ingress failure before caddy reopens (default: enabled)",
    )
    up_parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate preflight and report ordered maintenance rollout plan without touching containers",
    )

    rb_parser = subparsers.add_parser(
        "rollback",
        help="Verify backup digests & complete sha256 inventory, stop writers, restore DBs+ACLs, and restart --no-deps",
    )
    add_common_stack_args(rb_parser)
    rb_parser.add_argument(
        "--backup",
        default="latest",
        help="Backup identifier under .kodera-backups or 'latest' (default: latest)",
    )

    st_parser = subparsers.add_parser(
        "status",
        help="Validate preflight, inspect running containers, check HTTP isolation + WebRTC UDP, and list backups",
    )
    add_common_stack_args(st_parser)

    probe_parser = subparsers.add_parser(
        "probe-webrtc",
        help="Run headless RFC 5389 STUN and RFC 5766 TURN UDP allocation/loopback diagnostics",
    )
    probe_parser.add_argument("--env-file", type=Path, help="Optional operator .env file")
    probe_parser.add_argument("--domain", help="Public KODERA_DOMAIN hostname")
    probe_parser.add_argument(
        "--public-ip",
        action="append",
        dest="public_ips",
        help="Expected public IP for KODERA_DOMAIN (repeatable)",
    )
    probe_parser.add_argument("--stun-host", help="STUN / TURN UDP host")
    probe_parser.add_argument(
        "--stun-port",
        type=int,
        help=f"Explicit STUN UDP port (default: {webrtc_probe.DEFAULT_STUN_PORT})",
    )
    probe_parser.add_argument(
        "--ports",
        help=f"Comma-separated UDP ports or start-end ranges (default: {webrtc_probe.DEFAULT_STUN_PORT})",
    )
    probe_parser.add_argument("--port-range-start", type=int, default=None)
    probe_parser.add_argument("--port-range-end", type=int, default=None)
    probe_parser.add_argument("--max-ports", type=int, default=webrtc_probe.DEFAULT_MAX_PORT_SAMPLES)
    probe_parser.add_argument("--stun-username", help="Optional STUN short-term USERNAME")
    probe_parser.add_argument("--stun-password-env", help="Env var holding STUN password")
    probe_parser.add_argument("--fingerprint", action="store_true", help="Attach CRC-32 FINGERPRINT")
    probe_parser.add_argument("--turn-url", help="Optional RFC 5766 TURN UDP URL")
    probe_parser.add_argument("--turn-username", help="TURN username")
    probe_parser.add_argument(
        "--turn-password-env",
        default="KODERA_TURN_PASSWORD",
        help="Env var holding TURN password (default: KODERA_TURN_PASSWORD or TURN_PASSWORD)",
    )
    probe_parser.add_argument("--local-probe-host", help="Optional auxiliary STUN host")
    probe_parser.add_argument("--local-probe-port", type=int, help="Optional auxiliary STUN UDP port")
    probe_parser.add_argument(
        "--timeout",
        type=float,
        default=webrtc_probe.DEFAULT_BUDGET_SECONDS,
        help="Total UDP probe budget in seconds (< 2.5 s)",
    )
    probe_parser.add_argument("--json", action="store_true", help="Emit JSON report")

    return parser


def _forward_probe_webrtc(args: argparse.Namespace) -> int:
    forwarded: list[str] = []
    if args.env_file is not None:
        forwarded.extend(["--env-file", str(args.env_file)])
    if args.domain:
        forwarded.extend(["--domain", args.domain])
    for ip in args.public_ips or ():
        forwarded.extend(["--public-ip", ip])
    if args.stun_host:
        forwarded.extend(["--stun-host", args.stun_host])
    if args.stun_port is not None:
        forwarded.extend(["--stun-port", str(args.stun_port)])
    if args.ports:
        forwarded.extend(["--ports", args.ports])
    if args.port_range_start is not None:
        forwarded.extend(["--port-range-start", str(args.port_range_start)])
    if args.port_range_end is not None:
        forwarded.extend(["--port-range-end", str(args.port_range_end)])
    forwarded.extend(["--max-ports", str(args.max_ports)])
    if args.stun_username:
        forwarded.extend(["--stun-username", args.stun_username])
    if args.stun_password_env:
        forwarded.extend(["--stun-password-env", args.stun_password_env])
    if args.fingerprint:
        forwarded.append("--fingerprint")
    if args.turn_url:
        forwarded.extend(["--turn-url", args.turn_url])
    if args.turn_username:
        forwarded.extend(["--turn-username", args.turn_username])
    if args.turn_password_env:
        forwarded.extend(["--turn-password-env", args.turn_password_env])
    if args.local_probe_host:
        forwarded.extend(["--local-probe-host", args.local_probe_host])
    if args.local_probe_port is not None:
        forwarded.extend(["--local-probe-port", str(args.local_probe_port)])
    forwarded.extend(["--timeout", str(args.timeout)])
    if args.json:
        forwarded.append("--json")
    return webrtc_probe.main(forwarded)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.selftest:
        return selftest()

    if not args.subcommand:
        parser.print_help(sys.stderr)
        return 2

    if args.subcommand == "probe-webrtc":
        return _forward_probe_webrtc(args)

    secrets_for_err: frozenset[str] = frozenset()
    with contextlib.suppress(CtlError, OSError, ValueError):
        if args.env_file:
            _, secrets_for_err, _ = parse_operator_env(
                read_regular_utf8_nofollow(Path(args.env_file))
            )

    try:
        if args.subcommand == "upgrade":
            report = execute_upgrade(
                env_file=args.env_file,
                stack_dir=args.stack_dir,
                project_name=args.project_name,
                auto_rollback=args.auto_rollback,
                base_url_override=args.base_url,
                skip_preflight_http=args.skip_preflight_http,
                skip_webrtc_probe=args.skip_webrtc_probe,
                webrtc_port_override=args.webrtc_port,
                dry_run=args.dry_run,
            )
            exit_code = 0 if report["status"] in ("upgraded", "dry_run") else 1
        elif args.subcommand == "rollback":
            report = execute_rollback(
                env_file=args.env_file,
                stack_dir=args.stack_dir,
                backup_selector=args.backup,
                project_name=args.project_name,
                base_url_override=args.base_url,
                skip_preflight_http=args.skip_preflight_http,
                skip_webrtc_probe=args.skip_webrtc_probe,
                webrtc_port_override=args.webrtc_port,
            )
            exit_code = 0
        elif args.subcommand == "status":
            report = execute_status(
                env_file=args.env_file,
                stack_dir=args.stack_dir,
                project_name=args.project_name,
                base_url_override=args.base_url,
                skip_preflight_http=args.skip_preflight_http,
                skip_webrtc_probe=args.skip_webrtc_probe,
                webrtc_port_override=args.webrtc_port,
            )
            exit_code = 0
        else:
            parser.print_help(sys.stderr)
            return 2
    except CtlError as err:
        safe_msg = redact_secrets(str(err), secrets_for_err)
        if getattr(args, "json", False):
            print(json.dumps({"status": "error", "error": safe_msg}, sort_keys=True))
        else:
            print(f"[FAIL] {safe_msg}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(report, sort_keys=True))
    else:
        status_val = report.get("status")
        if status_val == "auto_rolled_back":
            print(
                f"[FAIL] Upgrade failed ({report.get('upgrade_error')}); "
                f"automatic rollback to {report.get('backup_id')} succeeded.",
                file=sys.stderr,
            )
        else:
            print(f"[OK] kodera-ctl {args.subcommand}: status={status_val}")
    return exit_code


if __name__ == "__main__":
    if hasattr(sys.stdout, "buffer") and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    raise SystemExit(main())
