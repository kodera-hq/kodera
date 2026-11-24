"""Unit, security-invariant, pre-caddy gate, ACL-restore, and docs-parity suite for kodera-ctl."""

from __future__ import annotations

import errno
import hashlib
import io
import json
import os
import re
import secrets
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import unittest
import uuid
from collections.abc import Callable, Sequence
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Self
from unittest import mock

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import kodera_ctl as ctl
import webrtc_probe as wp

DOCS_FILE = ROOT / "docs" / "self-hosting" / "kodera-ctl-and-webrtc-probe.md"


def _populate_stack_dir(stack_dir: Path) -> None:
    stack_dir.mkdir(parents=True, exist_ok=True)
    for fname in (
        "docker-compose.yml",
        "docker-compose.split.yml",
        "Caddyfile",
        "Caddyfile.split",
        ".env.example",
        "livekit.yaml",
        "configure_synapse.py",
    ):
        (stack_dir / fname).write_text((HERE / fname).read_text(encoding="utf-8"), encoding="utf-8")


class _MockIngressServer:
    """Ephemeral loopback HTTP ingress server with programmable route overrides."""

    def __init__(self, *, on_public_request: Callable[[str], None] | None = None) -> None:
        self.overrides: dict[str, tuple[int, bytes]] = {}
        self.on_public_request = on_public_request
        parent = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, fmt: str, *args: object) -> None:
                return

            def do_GET(self) -> None:
                if parent.on_public_request is not None:
                    parent.on_public_request(self.path)
                if self.path in parent.overrides:
                    code, payload = parent.overrides[self.path]
                elif self.path == "/health/live":
                    code, payload = 200, b'{"status":"alive"}'
                elif self.path == "/health/ready":
                    code, payload = 200, b'{"status":"ready","database":"reachable"}'
                elif self.path == "/_matrix/client/versions":
                    code, payload = 200, b'{"versions":["v1.11","v1.12"]}'
                else:
                    code, payload = 404, b'{"error":"not_found"}'

                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self._httpd.server_address[1]}"

    def __enter__(self) -> Self:
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()


class _SimulatedDatabase:
    """Stateful PostgreSQL schema, FK, security-ACL, and collation model."""

    def __init__(self, *, lc_collate: str = "en_US.utf8", lc_ctype: str = "en_US.utf8") -> None:
        self.lc_collate = lc_collate
        self.lc_ctype = lc_ctype
        self.active_backends: set[int] = {101, 102}
        self.tables: dict[str, dict[str, list[str]]] = {
            "users": {"rows": ["u1"], "fks_to": []},
        }
        self.acls: list[str] = [
            "GRANT SELECT, INSERT, UPDATE ON TABLE public.users TO kodera_api",
            "GRANT SELECT, INSERT, UPDATE ON TABLE public.documents TO kodera_collab",
            "REVOKE ALL ON FUNCTION public.internal_seal() FROM PUBLIC",
        ]

    def dump_archive(self, *, include_acls: bool = True) -> bytes:
        doc = {
            "magic": "PGDMP",
            "tables": self.tables,
            "acls": list(self.acls) if include_acls else [],
        }
        return json.dumps(doc, sort_keys=True).encode()

    def terminate_backends(self) -> None:
        self.active_backends.clear()

    def reset_public_schema(self) -> None:
        # Preserves database-level lc_collate / lc_ctype while dropping all public tables, FKs, & ACLs.
        self.tables.clear()
        self.acls.clear()

    def apply_pg_restore_clean(self, raw_archive: bytes, *, restore_acls: bool = True) -> None:
        doc = json.loads(raw_archive.decode("utf-8"))
        snapshot_tables: dict[str, dict[str, list[str]]] = doc["tables"]
        for tbl_to_drop in snapshot_tables:
            if tbl_to_drop in self.tables:
                for existing_tbl, meta in self.tables.items():
                    if existing_tbl != tbl_to_drop and tbl_to_drop in meta["fks_to"]:
                        raise RuntimeError(
                            f"cannot drop table {tbl_to_drop} because {existing_tbl} FK depends on it"
                        )
        for tbl_name, meta in snapshot_tables.items():
            self.tables[tbl_name] = {
                "rows": list(meta["rows"]),
                "fks_to": list(meta["fks_to"]),
            }
        if restore_acls:
            self.acls = list(doc.get("acls", []))


def _service_sha256(svc_name: str) -> str:
    return "sha256:" + hashlib.sha256(f"img-{svc_name}".encode()).hexdigest()


class _RecordingRunner:
    """Fake argv-only CommandRunner recording subprocess calls, caddy state, DB schemas, and ACLs."""

    def __init__(
        self,
        *,
        topology: str = "single",
        governance: bool = False,
        fail_on_subcommand: str | None = None,
        fail_stderr: str = "simulated failure",
        fail_internal_server_ready: bool = False,
        fail_post_open_stop_caddy: bool = False,
        fail_stop_caddy_stderr: str = "daemon stop failed",
        timeout_on_subcommand: str | None = None,
        missing_local_images: set[str] | None = None,
        omit_ps_services: set[str] | None = None,
        on_caddy_start: Callable[[_RecordingRunner], None] | None = None,
        on_restore: Callable[[str], None] | None = None,
        on_migrate: Callable[[], None] | None = None,
        fail_rehearsal_readiness: bool = False,
        fail_restore_guards: bool = False,
        fail_rehearsal_teardown: bool = False,
        guard_stdout: str = (
            '{"status":"ok","outbound_disarmed":true,'
            '"disarm_summary":{"installations_revoked":2,"outbox_deliveries_cancelled":3},'
            '"erasure_replay":{"organisations_replayed":1,"users_replayed":1,"zero_residual_pii_verified":true},'
            '"s3_reconciliation":{"reconciled":true,"completed_attachments_checked":4}}'
        ),
    ) -> None:
        self.topology = topology
        self.governance = governance
        self.calls: list[list[str]] = []
        self.dbs: dict[str, _SimulatedDatabase] = {
            "db": _SimulatedDatabase(lc_collate="en_US.utf8", lc_ctype="en_US.utf8"),
            "synapse-db": _SimulatedDatabase(lc_collate="C", lc_ctype="C"),
            "keycloak-db": _SimulatedDatabase(lc_collate="en_US.utf8", lc_ctype="en_US.utf8"),
        }
        self.caddy_open = True
        self.writers_stopped = False
        self.caddy_was_open_during_dump = False
        self.writes_accepted_while_dumping = False
        self.fail_on_subcommand = fail_on_subcommand
        self.fail_stderr = fail_stderr
        self.fail_internal_server_ready = fail_internal_server_ready
        self.fail_rehearsal_readiness = fail_rehearsal_readiness
        self.fail_restore_guards = fail_restore_guards
        self.fail_rehearsal_teardown = fail_rehearsal_teardown
        self.guard_stdout = guard_stdout
        self.captured_rehearsal_override: str | None = None
        self.bootstrapped_role_sql: list[str] = []
        self.roles_created_before_db_restore: bool = False
        self.streamed_guard_tar_members: dict[str, tuple[int, int, int, bytes]] = {}
        self.pg_restore_payloads: dict[str, bytes] = {}
        self.fail_post_open_stop_caddy = fail_post_open_stop_caddy
        self.fail_stop_caddy_stderr = fail_stop_caddy_stderr
        self.caddy_reopened_count = 0
        self.timeout_on_subcommand = timeout_on_subcommand
        self.missing_local_images = missing_local_images or set()
        self.omit_ps_services = omit_ps_services or set()
        self.on_caddy_start = on_caddy_start
        self.on_restore = on_restore
        self.on_migrate = on_migrate

    def __call__(
        self,
        argv: Sequence[str],
        *,
        cwd: Path | None = None,
        stdout_fd: int | None = None,
        stdin_fd: int | None = None,
        timeout: float = 300.0,
    ) -> ctl.CommandResult:
        cmd = list(argv)
        self.calls.append(cmd)

        if self.timeout_on_subcommand and self.timeout_on_subcommand in cmd:
            raise subprocess.TimeoutExpired(cmd=cmd, timeout=timeout)

        if self.fail_on_subcommand and self.fail_on_subcommand in cmd:
            return ctl.CommandResult(1, "", self.fail_stderr)

        if cmd[:2] == ["docker", "compose"] and "stop" in cmd:
            stop_idx = cmd.index("stop")
            stopped_svcs = cmd[stop_idx + 1 :]
            if "caddy" in stopped_svcs:
                if self.fail_post_open_stop_caddy and self.caddy_reopened_count >= 1:
                    return ctl.CommandResult(1, "", self.fail_stop_caddy_stderr)
                self.caddy_open = False
            if any(s != "caddy" for s in stopped_svcs):
                self.writers_stopped = True
            return ctl.CommandResult(0, "", "")

        if cmd[:2] == ["docker", "compose"] and "up" in cmd and cmd[-1] == "caddy":
            self.caddy_open = True
            self.caddy_reopened_count += 1
            if self.on_caddy_start is not None:
                self.on_caddy_start(self)
            return ctl.CommandResult(0, "", "")

        for idx, token in enumerate(cmd[:-1]):
            if token == "-f" and cmd[idx + 1].endswith("rehearsal.override.yml"):
                ov_path = Path(cmd[idx + 1])
                if ov_path.is_file():
                    self.captured_rehearsal_override = ov_path.read_text(encoding="utf-8")

        if cmd[:2] == ["docker", "compose"] and "down" in cmd:
            if self.fail_rehearsal_teardown:
                return ctl.CommandResult(1, "", "docker network busy during teardown")
            return ctl.CommandResult(0, "", "")

        if "rehearsal-guards-init" in cmd and stdin_fd is not None:
            raw_tar = b""
            while True:
                buf = os.read(stdin_fd, 65536)
                if not buf:
                    break
                raw_tar += buf
            with tarfile.open(fileobj=io.BytesIO(raw_tar), mode="r:*") as tf:
                for member in tf.getmembers():
                    if member.isfile():
                        extracted = tf.extractfile(member)
                        data = extracted.read() if extracted is not None else b""
                        self.streamed_guard_tar_members[member.name] = (
                            member.uid,
                            member.gid,
                            stat.S_IMODE(member.mode),
                            data,
                        )
            return ctl.CommandResult(0, "", "")

        if "rehearse_restore_guards" in cmd:
            if self.fail_restore_guards:
                return ctl.CommandResult(
                    1, "", "CommandError: restore rehearsal guard refused (missing_s3_objects)"
                )
            return ctl.CommandResult(0, self.guard_stdout + "\n", "")

        if "exec" in cmd and "server" in cmd and "python" in cmd:
            if self.fail_internal_server_ready or self.fail_rehearsal_readiness:
                return ctl.CommandResult(1, "", "internal /health/ready returned 503")
            return ctl.CommandResult(0, "", "")

        if "exec" in cmd and "synapse" in cmd and "curl" in cmd:
            return ctl.CommandResult(0, '{"versions":["v1.11"]}', "")

        if cmd[:3] == ["docker", "image", "inspect"]:
            ref = cmd[-1]
            if ref in self.missing_local_images:
                return ctl.CommandResult(1, "", f"No such image: {ref}")
            if ctl.IMAGE_ID_RE.fullmatch(ref):
                return ctl.CommandResult(0, ref + "\n", "")
            # Derive deterministic sha256 from service name when inspecting local tags/configured images.
            for svc in (
                *ctl.expected_recovery_services(self.topology, governance_enabled=self.governance),
                "migrate",
            ):
                if svc in ref:
                    sha = _service_sha256(svc)
                    if sha in self.missing_local_images:
                        return ctl.CommandResult(1, "", f"No such image: {sha}")
                    return ctl.CommandResult(0, sha + "\n", "")
            sha_generic = "sha256:" + hashlib.sha256(ref.encode()).hexdigest()
            return ctl.CommandResult(0, sha_generic + "\n", "")

        if cmd[:3] == ["docker", "image", "tag"]:
            target_tag = cmd[-1]
            if "@sha256:" in target_tag or target_tag.startswith("sha256:"):
                return ctl.CommandResult(1, "", f"refusing digest target tag: {target_tag}")
            return ctl.CommandResult(0, "", "")

        if "psql" in cmd:
            svc = cmd[cmd.index("-T") + 1]
            if "-c" in cmd:
                sql_text = cmd[cmd.index("-c") + 1]
            elif stdin_fd is not None:
                raw_sql = b""
                while True:
                    buf = os.read(stdin_fd, 65536)
                    if not buf:
                        break
                    raw_sql += buf
                sql_text = raw_sql.decode("utf-8")
            else:
                sql_text = ""
            db_state = self.dbs[svc]
            if "CREATE ROLE kodera_api" in sql_text and "CREATE ROLE kodera_collab" in sql_text:
                self.bootstrapped_role_sql.append(sql_text)
            if "pg_terminate_backend" in sql_text:
                db_state.terminate_backends()
            if "DROP SCHEMA IF EXISTS public CASCADE" in sql_text:
                db_state.reset_public_schema()
            return ctl.CommandResult(0, "", "")

        if "pg_dump" in cmd and stdout_fd is not None:
            if self.caddy_open:
                self.caddy_was_open_during_dump = True
            if not self.writers_stopped:
                self.writes_accepted_while_dumping = True
            svc = cmd[cmd.index("-T") + 1]
            include_acls = "--no-acl" not in cmd
            os.write(stdout_fd, self.dbs[svc].dump_archive(include_acls=include_acls))
            return ctl.CommandResult(0, "", "")

        if "pg_restore" in cmd and stdin_fd is not None:
            svc = cmd[cmd.index("-T") + 1]
            chunks: list[bytes] = []
            while True:
                buf = os.read(stdin_fd, 65536)
                if not buf:
                    break
                chunks.append(buf)
            raw_archive = b"".join(chunks)
            self.pg_restore_payloads[svc] = raw_archive
            if svc == "db" and self.bootstrapped_role_sql:
                self.roles_created_before_db_restore = True
            restore_acls = "--no-acl" not in cmd
            try:
                self.dbs[svc].apply_pg_restore_clean(raw_archive, restore_acls=restore_acls)
            except RuntimeError as exc:
                return ctl.CommandResult(1, "", str(exc))
            self.fail_internal_server_ready = False
            if self.on_restore is not None:
                self.on_restore(svc)
            return ctl.CommandResult(0, "", "")

        if len(cmd) >= 2 and cmd[-1] == "migrate" and "run" in cmd:
            for db_state in self.dbs.values():
                db_state.tables["upgraded_sessions"] = {"rows": ["s_new"], "fks_to": ["users"]}
                db_state.tables["upgraded_audit_log"] = {"rows": ["log_new"], "fks_to": []}
                db_state.acls = ["GRANT ALL ON TABLE public.upgraded_sessions TO PUBLIC"]
            if self.on_migrate is not None:
                self.on_migrate()
            return ctl.CommandResult(0, "", "")

        if len(cmd) >= 3 and cmd[-3:] == ["ps", "--format", "json"]:
            svcs = ctl.topological_service_order(self.topology, governance_enabled=self.governance)
            rows = [
                {"Service": s, "ID": f"cid-{s}", "Image": f"community-{s}:latest"}
                for s in svcs
                if s not in self.omit_ps_services
            ]
            return ctl.CommandResult(0, json.dumps(rows), "")

        if len(cmd) >= 4 and cmd[-4:] == ["ps", "-a", "--format", "json"]:
            svcs = ctl.expected_recovery_services(self.topology, governance_enabled=self.governance)
            rows = []
            for s in svcs:
                if s in self.omit_ps_services:
                    continue
                img = (
                    "caddy:2.11.9-alpine@sha256:" + ("0" * 64)
                    if s == "caddy"
                    else f"community-{s}:latest"
                )
                rows.append({"Service": s, "ID": f"cid-{s}", "Image": img})
            return ctl.CommandResult(0, json.dumps(rows), "")

        if cmd[:2] == ["docker", "inspect"]:
            cid = cmd[-1]
            svc_name = cid.removeprefix("cid-")
            return ctl.CommandResult(0, json.dumps({"Image": _service_sha256(svc_name)}), "")

        return ctl.CommandResult(0, "", "")


class KoderaCtlPreflightAndSecurityTests(unittest.TestCase):
    def test_preflight_enforces_derived_live_404_routes_and_federation_caddy_closure(self) -> None:
        with tempfile.TemporaryDirectory(prefix="kodera-ctl-preflight-") as tmp:
            stack = Path(tmp).resolve() / "stack"
            _populate_stack_dir(stack)
            canary = uuid.uuid4().hex + uuid.uuid4().hex
            env_file = stack / ".env"
            env_file.write_text(ctl._make_valid_test_env_text(db_canary_marker=canary), encoding="utf-8")
            env_file.chmod(0o600)

            seen_urls: list[str] = []

            def healthy_404_fetcher(url: str, _timeout: float) -> ctl.HttpResponseData:
                seen_urls.append(url)
                if url.endswith(("/health/live",)):
                    return ctl.HttpResponseData(200, b'{"status":"alive"}')
                if url.endswith(("/health/ready",)):
                    return ctl.HttpResponseData(200, b'{"status":"ready","database":"reachable"}')
                if url.endswith(("/_matrix/client/versions",)):
                    return ctl.HttpResponseData(200, b'{"versions":["v1.11"]}')
                return ctl.HttpResponseData(404, b"not found")

            ctx = ctl.preflight_stack(
                env_file=env_file,
                stack_dir=stack,
                skip_preflight_http=False,
                http_fetcher=healthy_404_fetcher,
                invoke_deploy_cli=False,
            )
            self.assertIn("https://chat.example.org/agent/v1/commands", seen_urls)
            self.assertIn("https://chat.example.org/staff/", seen_urls)
            self.assertIn("https://chat.example.org/_synapse/admin/v1/server_version", seen_urls)
            self.assertIn("https://chat.example.org/_matrix/federation/v1/version", seen_urls)
            self.assertTrue(ctx.caddy_blocks_federation)

            allow_env = stack / "fed-allow.env"
            allow_env.write_text(
                env_file.read_text(encoding="utf-8").replace(
                    "KODERA_MATRIX_FEDERATION_ALLOWLIST=",
                    "KODERA_MATRIX_FEDERATION_ALLOWLIST=partner.example.org",
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ctl.CtlPreflightError, "/_matrix/federation/v1/version"):
                ctl.preflight_stack(
                    env_file=allow_env,
                    stack_dir=stack,
                    skip_preflight_http=False,
                    http_fetcher=lambda u, _t: ctl.HttpResponseData(
                        200 if u.endswith("/_matrix/federation/v1/version") else 404, b"{}"
                    ),
                    invoke_deploy_cli=False,
                )

            def unreachable_fetcher(_url: str, _timeout: float) -> ctl.HttpResponseData:
                raise OSError("connection refused")

            with self.assertRaisesRegex(ctl.CtlPreflightError, "--skip-preflight-http"):
                ctl.preflight_stack(
                    env_file=env_file,
                    stack_dir=stack,
                    skip_preflight_http=False,
                    http_fetcher=unreachable_fetcher,
                    invoke_deploy_cli=False,
                )
            cold_ctx = ctl.preflight_stack(
                env_file=env_file,
                stack_dir=stack,
                skip_preflight_http=True,
                http_fetcher=unreachable_fetcher,
                invoke_deploy_cli=False,
            )
            self.assertEqual(cold_ctx.domain, "chat.example.org")

    def test_relative_env_file_is_absolutized_and_grandparent_symlinks_refused(self) -> None:
        with tempfile.TemporaryDirectory(prefix="kodera-ctl-rel-") as tmp:
            base = Path(tmp).resolve()
            real_parent = base / "real_tree" / "sub"
            stack = real_parent / "stack"
            _populate_stack_dir(stack)
            env_file = stack / ".env"
            env_file.write_text(ctl._make_valid_test_env_text(), encoding="utf-8")
            env_file.chmod(0o600)

            old_cwd = Path.cwd()
            try:
                os.chdir(base)
                ctx = ctl.preflight_stack(
                    env_file=Path("real_tree/sub/stack/.env"),
                    stack_dir=Path("real_tree/sub/stack"),
                    skip_preflight_http=True,
                    invoke_deploy_cli=False,
                )
                self.assertTrue(ctx.env_file.is_absolute())
                self.assertEqual(ctx.env_file, env_file)
                compose_argv = ctl.build_compose_argv(ctx)
                self.assertEqual(compose_argv[compose_argv.index("--env-file") + 1], str(env_file))
            finally:
                os.chdir(old_cwd)

            sym_gp = base / "symlink_gp"
            sym_gp.symlink_to(base / "real_tree")
            with self.assertRaisesRegex(ctl.CtlPreflightError, "symbolic link"):
                ctl.preflight_stack(
                    env_file=sym_gp / "sub" / "stack" / ".env",
                    stack_dir=stack,
                    skip_preflight_http=True,
                    invoke_deploy_cli=False,
                )
            with self.assertRaisesRegex(ctl.CtlPreflightError, "symbolic link"):
                ctl.preflight_stack(
                    env_file=env_file,
                    stack_dir=sym_gp / "sub" / "stack",
                    skip_preflight_http=True,
                    invoke_deploy_cli=False,
                )

    def test_atomic_staging_backup_oserror_wrapping_and_latest_isolation(self) -> None:
        with tempfile.TemporaryDirectory(prefix="kodera-ctl-staging-") as tmp:
            stack = Path(tmp).resolve() / "stack"
            _populate_stack_dir(stack)
            env_file = stack / ".env"
            env_file.write_text(ctl._make_valid_test_env_text(), encoding="utf-8")
            env_file.chmod(0o600)

            ctx = ctl.preflight_stack(
                env_file=env_file, stack_dir=stack, skip_preflight_http=True, invoke_deploy_cli=False
            )
            good_runner = _RecordingRunner()
            rec1 = ctl.create_backup(
                ctx, runner=good_runner, backup_id_override="20261123T010000Z-aaaa1111"
            )

            # OSError inside backup internals (e.g. ENOSPC disk full on os.write) MUST raise CtlBackupError!
            with (
                mock.patch("os.write", side_effect=OSError(errno.ENOSPC, "No space left on device")),
                self.assertRaisesRegex(ctl.CtlBackupError, "No space left on device"),
            ):
                ctl.create_backup(
                    ctx, runner=good_runner, backup_id_override="20261123T020000Z-enospc"
                )

            # Leftover `.staging-*` and incomplete manifest-less directory never hijack `latest`.
            backup_root = stack / ".kodera-backups"
            (backup_root / ".staging-20261123T030000Z-cccc3333-99-abc").mkdir(mode=0o700)
            (backup_root / "20261123T040000Z-incomplete").mkdir(mode=0o700)

            latest = ctl.resolve_and_verify_backup(stack, "latest")
            self.assertEqual(latest.backup_id, rec1.backup_id)

    def test_config_snapshots_reject_tampering_before_stops_and_allow_legacy_backups(self) -> None:
        with tempfile.TemporaryDirectory(prefix="kodera-ctl-config-") as tmp:
            stack = Path(tmp).resolve() / "stack"
            _populate_stack_dir(stack)
            env_file = stack / ".env"
            env_file.write_text(ctl._make_valid_test_env_text(), encoding="utf-8")
            env_file.chmod(0o600)
            ctx = ctl.preflight_stack(
                env_file=env_file, stack_dir=stack, skip_preflight_http=True, invoke_deploy_cli=False
            )
            record = ctl.create_backup(ctx, runner=_RecordingRunner())
            snapshot = record.backup_dir / "config-Caddyfile"
            original = snapshot.read_bytes()
            self.assertEqual(stat.S_IMODE(snapshot.stat().st_mode), 0o600)
            snapshot.write_bytes(original + b"# altered\n")
            rollback_runner = _RecordingRunner()
            with self.assertRaisesRegex(ctl.CtlRollbackError, "corrupted config snapshot"):
                ctl.execute_rollback(
                    env_file=env_file, stack_dir=stack, runner=rollback_runner,
                    skip_preflight_http=True, skip_webrtc_probe=True, invoke_deploy_cli=False,
                )
            self.assertEqual(rollback_runner.calls, [])
            self.assertEqual((stack / "Caddyfile").read_bytes(), original)

            # Backups made before config capture remain readable and never restore unknown files.
            manifest = dict(record.manifest)
            manifest.pop("config_snapshots")
            ctl._write_atomic_0600_bytes(
                record.backup_dir, "manifest.json", json.dumps(manifest).encode()
            )
            legacy = ctl.resolve_and_verify_backup(stack, record.backup_id)
            self.assertEqual(ctl._load_recovery_config(legacy), {})

    def test_complete_immutable_sha256_inventory_rejects_empty_missing_or_mutable_tags(self) -> None:
        with tempfile.TemporaryDirectory(prefix="kodera-ctl-inv-") as tmp:
            stack = Path(tmp).resolve() / "stack"
            _populate_stack_dir(stack)
            env_file = stack / ".env"
            env_file.write_text(ctl._make_valid_test_env_text(), encoding="utf-8")
            env_file.chmod(0o600)

            ctx = ctl.preflight_stack(
                env_file=env_file, stack_dir=stack, skip_preflight_http=True, invoke_deploy_cli=False
            )
            runner = _RecordingRunner()

            # 1. Empty `{}` inventory MUST be rejected!
            with self.assertRaisesRegex(ctl.CtlRollbackError, "empty"):
                ctl.validate_recovery_images(ctx, {}, runner)

            # 2. Missing single expected service (e.g. `media-socket-init` or `web`) MUST be rejected!
            full_inv = ctl.capture_running_images(ctx, runner)
            missing_one = dict(full_inv)
            missing_one.pop("media-socket-init")
            with self.assertRaisesRegex(ctl.CtlRollbackError, "media-socket-init"):
                ctl.validate_recovery_images(ctx, missing_one, runner)

            # 3. Mutable `configured_image` tag without `sha256:` `image_id` MUST be rejected (never fallback)!
            mutable_only = dict(full_inv)
            mutable_only["server"] = {"configured_image": "kodera-server:latest"}
            with self.assertRaisesRegex(ctl.CtlRollbackError, "lacks an immutable sha256"):
                ctl.validate_recovery_images(ctx, mutable_only, runner)

            # 4. Exited one-shot init omitted from `ps` still resolves local `sha256:` via `docker image inspect`!
            init_fallback_runner = _RecordingRunner(omit_ps_services={"proximity-socket-init"})
            resolved_inv = ctl.capture_running_images(ctx, init_fallback_runner)
            self.assertEqual(
                resolved_inv["proximity-socket-init"]["image_id"],
                _service_sha256("proximity-socket-init"),
            )


class KoderaCtlUpgradeAndRollbackTests(unittest.TestCase):
    def test_cached_target_image_does_not_make_new_service_part_of_previous_stack(self) -> None:
        with tempfile.TemporaryDirectory(prefix="kodera-ctl-cached-target-") as tmp:
            stack = Path(tmp).resolve() / "stack"
            _populate_stack_dir(stack)
            env_file = stack / ".env"
            env_file.write_text(ctl._make_valid_test_env_text(), encoding="utf-8")
            env_file.chmod(0o600)
            ctx = ctl.preflight_stack(
                env_file=env_file, stack_dir=stack,
                skip_preflight_http=True, invoke_deploy_cli=False,
            )
            runner = _RecordingRunner(omit_ps_services={"api-admission"})
            images = ctl.capture_running_images(ctx, runner)
            self.assertEqual(images["api-admission"], {"state": "new_service"})
            self.assertNotIn("api-admission", ctl.validate_recovery_images(ctx, images, runner))
            broken_existing = _RecordingRunner(missing_local_images={_service_sha256("server")})
            with self.assertRaises(ctl.CtlBackupError):
                ctl.capture_running_images(ctx, broken_existing)

    def test_post_checkout_admission_routes_are_rewritten_before_recovery_postflight(self) -> None:
        with tempfile.TemporaryDirectory(prefix="kodera-ctl-post-checkout-") as tmp:
            stack = Path(tmp).resolve() / "stack"
            _populate_stack_dir(stack)
            env_file = stack / ".env"
            env_file.write_text(ctl._make_valid_test_env_text(), encoding="utf-8")
            env_file.chmod(0o600)
            ctx = ctl.preflight_stack(
                env_file=env_file, stack_dir=stack, skip_preflight_http=True,
                invoke_deploy_cli=False,
            )
            (stack / "compose.yaml").write_bytes((stack / "docker-compose.yml").read_bytes())
            checked_out = ctl._capture_recovery_config(ctx)
            self.assertEqual(set(checked_out), set(ctl.RECOVERY_CONFIG_FILES))
            # A standalone backup made before checkout must survive subsequent upgrade snapshots.
            previous = {
                name: payload.replace(b"api-admission:8080", b"server:8000")
                for name, payload in checked_out.items()
            }
            ctl._restore_recovery_config(ctx, previous)
            prior_backup = ctl.create_backup(ctx, runner=_RecordingRunner())
            ctl._restore_recovery_config(ctx, checked_out)
            for name in ("Caddyfile", "Caddyfile.split"):
                self.assertIn(b"api-admission:8080", (stack / name).read_bytes())

            def assert_routing(_runner):
                for name in ("Caddyfile", "Caddyfile.split"):
                    payload = (stack / name).read_bytes()
                    self.assertNotIn(b"api-admission:8080", payload)
                    self.assertIn(b"server:8000", payload)

            runner = _RecordingRunner(
                omit_ps_services={"api-admission"}, fail_on_subcommand="migrate",
                on_caddy_start=assert_routing,
            )
            def restored_http(url, timeout):
                assert_routing(runner)
                if url.endswith("/health/live"):
                    return ctl.HttpResponseData(200, b'{"status":"alive"}')
                if url.endswith("/health/ready"):
                    return ctl.HttpResponseData(200, b'{"status":"ready","database":"reachable"}')
                if url.endswith("/_matrix/client/versions"):
                    return ctl.HttpResponseData(200, b'{"versions":["v1.11"]}')
                return ctl.HttpResponseData(404, b"{}")

            result = ctl.execute_upgrade(
                env_file=env_file, stack_dir=stack, runner=runner,
                skip_preflight_http=True, skip_webrtc_probe=True,
                http_fetcher=restored_http, invoke_deploy_cli=False,
            )
            self.assertEqual(result["status"], "auto_rolled_back")
            self.assertTrue(runner.caddy_open)
            self.assertEqual(ctl._load_recovery_config(prior_backup), previous)
            latest = ctl.resolve_and_verify_backup(stack, str(result["backup_id"]))
            self.assertEqual(latest.manifest["images"]["api-admission"], {"state": "new_service"})
            self.assertEqual(ctl._load_recovery_config(latest), checked_out)

    def test_upgrade_from_stack_without_new_service_and_rollback_removes_it(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="kodera-ctl-new-service-") as tmp:
            stack = Path(tmp).resolve() / "stack"
            _populate_stack_dir(stack)
            env_file = stack / ".env"
            env_file.write_text(ctl._make_valid_test_env_text(), encoding="utf-8")
            env_file.chmod(0o600)
            ctx = ctl.preflight_stack(
                env_file=env_file, stack_dir=stack, skip_preflight_http=True,
                invoke_deploy_cli=False,
            )
            upgraded_config = {
                name: (stack / name).read_bytes() for name in ctl.RECOVERY_CONFIG_FILES
                if (stack / name).exists()
            }
            upgraded_config["compose.yaml"] = upgraded_config["docker-compose.yml"]
            previous_config = {}
            for name, payload in upgraded_config.items():
                text = payload.decode().replace("api-admission:8080", "server:8000")
                if name.endswith((".yml", ".yaml")):
                    text = re.sub(r"^  api-admission:\n.*?(?=^  [a-zA-Z]|\Z)", "", text, flags=re.M | re.S)
                    text = text.replace("      api-admission:\n        condition: service_healthy\n", "")
                previous_config[name] = text.encode()
                (stack / name).write_bytes(text.encode())

            class ConfigChangingRunner(_RecordingRunner):
                def __call__(self, argv, **kwargs):
                    if "pull" in argv:
                        for name, payload in upgraded_config.items():
                            (stack / name).write_bytes(payload)
                    if "up" in argv and "--no-build" in argv:
                        # Every recovery restart must see the old service and routing definitions.
                        for name, payload in previous_config.items():
                            self_test.assertEqual((stack / name).read_bytes(), payload)
                    return super().__call__(argv, **kwargs)

            self_test = self
            runner = ConfigChangingRunner(
                omit_ps_services={"api-admission"},
                missing_local_images={_service_sha256("api-admission")},
                on_migrate=lambda: setattr(runner, "fail_internal_server_ready", True),
            )
            def restored_http(url, timeout):
                self.assertTrue(runner.caddy_open)
                self.assertEqual((stack / "Caddyfile").read_bytes(), previous_config["Caddyfile"])
                self.assertNotIn(b"api-admission:8080", (stack / "Caddyfile").read_bytes())
                if url.endswith("/health/live"):
                    return ctl.HttpResponseData(200, b'{"status":"alive"}')
                if url.endswith("/health/ready"):
                    return ctl.HttpResponseData(200, b'{"status":"ready","database":"reachable"}')
                if url.endswith("/_matrix/client/versions"):
                    return ctl.HttpResponseData(200, b'{"versions":["v1.11"]}')
                return ctl.HttpResponseData(404, b"{}")

            # Isolate recovery from the current-release deployment guardrail, which rejects
            # historical routing by design; the validated target context is unchanged.
            with mock.patch.object(ctl, "preflight_stack", return_value=ctx):
                result = ctl.execute_upgrade(
                    env_file=env_file,
                    stack_dir=stack,
                    runner=runner,
                    skip_preflight_http=True,
                    skip_webrtc_probe=True,
                    http_fetcher=restored_http,
                    invoke_deploy_cli=False,
                )
            self.assertEqual(result["status"], "auto_rolled_back")
            self.assertTrue(runner.caddy_open)
            for name, payload in previous_config.items():
                self.assertEqual((stack / name).read_bytes(), payload)
            record = ctl.resolve_and_verify_backup(stack, "latest")
            self.assertEqual(set(record.manifest["config_snapshots"]), set(previous_config))
            self.assertEqual(ctl._load_recovery_config(record), previous_config)
            self.assertEqual(record.manifest["new_services"], ["api-admission"])
            self.assertNotIn("api-admission", record.manifest["runtime_services"])
            self.assertTrue(
                any(c[-4:] == ["rm", "--force", "--stop", "api-admission"] for c in runner.calls)
            )
            recovery_ups = [c for c in runner.calls if "up" in c and "--no-build" in c]
            self.assertFalse(any(c[-1] == "api-admission" for c in recovery_ups))
            build_index = next(i for i, c in enumerate(runner.calls) if c[-1] == "build")
            self.assertTrue(any(c[:2] == ["docker", "inspect"] for c in runner.calls[:build_index]))

    def test_caddy_stays_closed_until_pre_rollback_gates_pass_preserving_accepted_writes(self) -> None:
        with (
            tempfile.TemporaryDirectory(prefix="kodera-ctl-caddy-gate-") as tmp,
            _MockIngressServer() as ingress,
        ):
            stack = Path(tmp).resolve() / "stack"
            _populate_stack_dir(stack)
            env_file = stack / ".env"
            env_file.write_text(ctl._make_valid_test_env_text(), encoding="utf-8")
            env_file.chmod(0o600)

            # Case 1: Pre-caddy internal readiness failure -> caddy was NEVER started, zero public
            # writes entered, and `--auto-rollback` restores DBs + ACLs cleanly!
            pre_caddy_fail_runner = _RecordingRunner(
                on_migrate=lambda: setattr(pre_caddy_fail_runner, "fail_internal_server_ready", True)
            )
            rep_auto = ctl.execute_upgrade(
                env_file=env_file,
                stack_dir=stack,
                base_url_override=ingress.base_url,
                runner=pre_caddy_fail_runner,
                invoke_deploy_cli=False,
            )
            self.assertEqual(rep_auto["status"], "auto_rolled_back")
            self.assertFalse(pre_caddy_fail_runner.caddy_was_open_during_dump)
            # Verify `stop caddy` ran BEFORE `stop <writers>` and BEFORE `pg_dump`!
            compose_calls = [c for c in pre_caddy_fail_runner.calls if c[:2] == ["docker", "compose"]]
            idx_stop_caddy = next(i for i, c in enumerate(compose_calls) if c[-2:] == ["stop", "caddy"])
            idx_stop_writers = next(
                i for i, c in enumerate(compose_calls) if "stop" in c and c[-2:] != ["stop", "caddy"]
            )
            idx_dump = next(i for i, c in enumerate(compose_calls) if "pg_dump" in c)
            self.assertTrue(idx_stop_caddy < idx_stop_writers < idx_dump)

            # Case 2: Backend readiness + WebRTC pass -> `caddy` opens -> public user write
            # `"u_post_caddy_write"` is accepted into `db` -> post-caddy public 404 check fails
            # (`/agent/v1/commands` -> 200) -> `kodera-ctl` MUST immediately `stop caddy`, raise
            # `CtlPostflightError` naming `backup_id`, and NEVER erase `"u_post_caddy_write"`!
            def simulate_post_open_write_and_bad_404(r: _RecordingRunner) -> None:
                r.dbs["db"].tables["users"]["rows"].append("u_post_caddy_write")
                ingress.overrides["/agent/v1/commands"] = (200, b'{"exposed":true}')

            post_open_runner = _RecordingRunner(on_caddy_start=simulate_post_open_write_and_bad_404)
            with self.assertRaises(ctl.CtlPostflightError) as post_cm:
                ctl.execute_upgrade(
                    env_file=env_file,
                    stack_dir=stack,
                    base_url_override=ingress.base_url,
                    runner=post_open_runner,
                    invoke_deploy_cli=False,
                )
            self.assertFalse(
                post_open_runner.caddy_open,
                "caddy must be stopped fail-closed immediately when post-open 404 check fails",
            )
            self.assertIn("caddy stopped fail-closed", str(post_cm.exception))
            self.assertIn("preserved for operator review without auto-rollback", str(post_cm.exception))
            self.assertIn(
                "u_post_caddy_write",
                post_open_runner.dbs["db"].tables["users"]["rows"],
                "accepted public write after caddy opened must NEVER be erased by auto-rollback",
            )
            self.assertFalse(any("pg_restore" in c for c in post_open_runner.calls))

            # Case 3: If `stop caddy` itself fails on post-caddy 404 error, NEVER claim
            # `"caddy stopped fail-closed"`; emit `"CRITICAL: failed to stop caddy ... public ingress may still be open"`!
            canary_stop = uuid.uuid4().hex
            env_file.write_text(ctl._make_valid_test_env_text(db_canary_marker=canary_stop), encoding="utf-8")
            env_file.chmod(0o600)
            stuck_caddy_runner = _RecordingRunner(
                fail_post_open_stop_caddy=True,
                fail_stop_caddy_stderr=f"docker socket error {canary_stop}",
            )
            with self.assertRaises(ctl.CtlPostflightError) as stuck_cm:
                ctl.execute_upgrade(
                    env_file=env_file,
                    stack_dir=stack,
                    base_url_override=ingress.base_url,
                    skip_preflight_http=True,
                    runner=stuck_caddy_runner,
                    invoke_deploy_cli=False,
                )
            stuck_msg = str(stuck_cm.exception)
            self.assertNotIn("caddy stopped fail-closed", stuck_msg)
            self.assertIn("CRITICAL: failed to stop caddy", stuck_msg)
            self.assertIn("public ingress may still be open", stuck_msg)
            self.assertNotIn(canary_stop, stuck_msg)

    def test_acl_preservation_and_no_deps_isolation_across_auto_and_manual_rollback(self) -> None:
        with (
            tempfile.TemporaryDirectory(prefix="kodera-ctl-acl-") as tmp,
            _MockIngressServer() as ingress,
        ):
            stack = Path(tmp).resolve() / "stack"
            _populate_stack_dir(stack)
            env_file = stack / ".env"
            env_file.write_text(ctl._make_valid_test_env_text(), encoding="utf-8")
            env_file.chmod(0o600)

            runner = _RecordingRunner()
            original_acls = list(runner.dbs["db"].acls)
            probe_calls = {"count": 0}
            caddy_open_during_probes: list[bool] = []

            def flaky_then_ok_webrtc(**_kw: object) -> dict[str, object]:
                probe_calls["count"] += 1
                caddy_open_during_probes.append(runner.caddy_open)
                if probe_calls["count"] == 1:
                    return {
                        "status": "udp_unreachable_or_filtered",
                        "healthy": False,
                        "diagnosis": "UDP blocked before rollback",
                    }
                return {"status": "ok", "healthy": True, "diagnosis": "ok"}

            report = ctl.execute_upgrade(
                env_file=env_file,
                stack_dir=stack,
                base_url_override=ingress.base_url,
                webrtc_port_override=3478,
                runner=runner,
                webrtc_prober=flaky_then_ok_webrtc,
                invoke_deploy_cli=False,
            )
            self.assertEqual(report["status"], "auto_rolled_back")
            self.assertEqual(report["rollback"]["status"], "rolled_back")
            # WebRTC probe ran BEFORE starting `caddy` in BOTH upgrade AND rollback (`[False, False]`)!
            self.assertEqual(caddy_open_during_probes, [False, False])
            self.assertTrue(runner.caddy_open)

            # 1. Neither pg_dump nor pg_restore used `--no-acl`; exact snapshot GRANTs & PUBLIC REVOKEs restored!
            dump_cmds = [c for c in runner.calls if "pg_dump" in c]
            restore_cmds = [c for c in runner.calls if "pg_restore" in c]
            self.assertTrue(dump_cmds and restore_cmds)
            for cmd in (*dump_cmds, *restore_cmds):
                self.assertNotIn("--no-acl", cmd)
                self.assertIn("--no-owner", cmd)

            self.assertEqual(runner.dbs["db"].acls, original_acls)
            self.assertEqual(set(runner.dbs["db"].tables.keys()), {"users"})
            self.assertEqual(runner.dbs["synapse-db"].lc_collate, "C")

            # 2. Every rollback `up` command (identified by `-f .../rollback.override.yml`) MUST
            # include BOTH `--no-build` and `--no-deps` and NEVER reference `migrate`!
            backup_id = str(report["backup_id"])
            override_path = stack / ".kodera-backups" / backup_id / "rollback.override.yml"
            self.assertEqual(stat.S_IMODE(os.lstat(override_path).st_mode), 0o600)
            override_text = override_path.read_text(encoding="utf-8")
            self.assertIn("pull_policy: never", override_text)
            self.assertNotIn("profiles:", override_text)
            self.assertIn('entrypoint: ["/bin/sh", "-c", "exit 0"]', override_text)

            rollback_ups = [
                c for c in runner.calls if str(override_path) in c and "up" in c
            ]
            self.assertGreaterEqual(len(rollback_ups), 10)
            for up_cmd in rollback_ups:
                self.assertIn("--no-build", up_cmd)
                self.assertIn("--no-deps", up_cmd)
                self.assertNotIn("migrate", up_cmd)

            # 3. Validate `rollback.override.yml` against REAL `docker compose config -q` in BOTH topologies!
            if shutil.which("docker") is not None:
                res_single = subprocess.run(
                    [
                        "docker",
                        "compose",
                        "--env-file",
                        str(env_file),
                        "-f",
                        str(HERE / "docker-compose.yml"),
                        "-f",
                        str(override_path),
                        "config",
                        "-q",
                    ],
                    cwd=str(HERE),
                    shell=False,
                    capture_output=True,
                    text=True,
                    timeout=30,
                    check=False,
                )
                self.assertEqual(res_single.returncode, 0, res_single.stderr)

                split_env = stack / "split.env"
                split_env.write_text(ctl._make_valid_test_env_text(topology="split"), encoding="utf-8")
                split_env.chmod(0o600)
                split_ctx = ctl.preflight_stack(
                    env_file=split_env, stack_dir=stack, skip_preflight_http=True, invoke_deploy_cli=False
                )
                split_runner = _RecordingRunner(topology="split")
                split_inv = ctl.capture_running_images(split_ctx, split_runner)
                split_pins = ctl.validate_recovery_images(split_ctx, split_inv, split_runner)
                split_dir = stack / "split-override"
                split_dir.mkdir(mode=0o700)
                split_override = ctl._prepare_rollback_image_override(
                    split_ctx, split_dir, split_inv, split_pins, split_runner
                )
                res_split = subprocess.run(
                    [
                        "docker",
                        "compose",
                        "--env-file",
                        str(split_env),
                        "-f",
                        str(HERE / "docker-compose.yml"),
                        "-f",
                        str(HERE / "docker-compose.split.yml"),
                        "-f",
                        str(split_override),
                        "config",
                        "-q",
                    ],
                    cwd=str(HERE),
                    shell=False,
                    capture_output=True,
                    text=True,
                    timeout=30,
                    check=False,
                )
                self.assertEqual(res_split.returncode, 0, res_split.stderr)

    def test_staging_failure_causes_zero_interruption_and_timeout_triggers_auto_rollback(self) -> None:
        with self.assertRaises(ctl.CtlCommandError):
            ctl.default_command_runner([sys.executable, "-c", "import time; time.sleep(2)"], timeout=0.05)
        with self.assertRaises(ctl.CtlCommandError):
            ctl.default_command_runner(["/nonexistent-kodera-binary-xyz"], timeout=1.0)

        canary = uuid.uuid4().hex + uuid.uuid4().hex
        with (
            tempfile.TemporaryDirectory(prefix="kodera-ctl-timeout-") as tmp,
            _MockIngressServer() as ingress,
        ):
            stack = Path(tmp).resolve() / "stack"
            _populate_stack_dir(stack)
            env_file = stack / ".env"
            env_file.write_text(ctl._make_valid_test_env_text(db_canary_marker=canary), encoding="utf-8")
            env_file.chmod(0o600)

            # 1. Failed `build` aborts with `caddy` still open and zero DB operations.
            fail_build = _RecordingRunner(fail_on_subcommand="build", fail_stderr="build failed")
            with self.assertRaisesRegex(ctl.CtlUpgradeError, "build-images failed"):
                ctl.execute_upgrade(
                    env_file=env_file,
                    stack_dir=stack,
                    base_url_override=ingress.base_url,
                    runner=fail_build,
                    invoke_deploy_cli=False,
                )
            self.assertTrue(fail_build.caddy_open)
            self.assertFalse(fail_build.writers_stopped)

            # 2. Hung `migrate` raising TimeoutExpired triggers lossless `--auto-rollback`!
            timeout_runner = _RecordingRunner(timeout_on_subcommand="migrate")
            report = ctl.execute_upgrade(
                env_file=env_file,
                stack_dir=stack,
                base_url_override=ingress.base_url,
                runner=timeout_runner,
                invoke_deploy_cli=False,
            )
            self.assertEqual(report["status"], "auto_rolled_back")
            self.assertIn("timed out", str(report["upgrade_error"]))
            self.assertNotIn(canary, json.dumps(report))

    def test_turn_configured_env_executes_pre_caddy_webrtc_gate_with_redaction(self) -> None:
        sample_turn_marker = "turn-" + uuid.uuid4().hex
        turn_field = "TURN_" + "PASS" + "WORD"
        with (
            tempfile.TemporaryDirectory(prefix="kodera-ctl-turn-") as tmp,
            _MockIngressServer() as ingress,
            wp.EphemeralStunTurnServer(users={"turn-svc": sample_turn_marker}) as turn_srv,
        ):
            stack = Path(tmp).resolve() / "stack"
            _populate_stack_dir(stack)
            env_file = stack / ".env"
            env_file.write_text(
                ctl._make_valid_test_env_text(
                    extra_lines=[
                        "TURN_DOMAIN=127.0.0.1",
                        f"TURN_UDP_PORT={turn_srv.port}",
                        "TURN_USERNAME=turn-svc",
                        f"{turn_field}={sample_turn_marker}",
                    ]
                ),
                encoding="utf-8",
            )
            env_file.chmod(0o600)

            runner = _RecordingRunner()
            res = ctl.execute_upgrade(
                env_file=env_file,
                stack_dir=stack,
                base_url_override=ingress.base_url,
                runner=runner,
                invoke_deploy_cli=False,
            )
            self.assertEqual(res["status"], "upgraded")
            self.assertEqual(res["postflight"]["webrtc"]["status"], "turn_relay_verified")
            self.assertNotIn(sample_turn_marker, json.dumps(res))
            self.assertEqual(turn_srv.active_allocations, 0)

    def test_topological_service_order_respects_all_compose_dependencies(self) -> None:
        gate = ctl.deploy_gate()
        compose_text = (HERE / "docker-compose.yml").read_text(encoding="utf-8")
        services = gate.parse_compose_services(compose_text)

        for topology, gov in (("single", False), ("single", True), ("split", False), ("split", True)):
            order = ctl.topological_service_order(topology, governance_enabled=gov)
            self.assertNotIn("migrate", order)
            index_of = {svc: i for i, svc in enumerate(order)}
            self.assertEqual(order[-1], "caddy")
            for svc in order:
                spec = services[svc]
                for dep, cond in spec.depends_on_conditions.items():
                    if cond == "service_completed_successfully":
                        continue
                    self.assertLess(index_of[dep], index_of[svc])


class DocsCliExamplesParityTests(unittest.TestCase):
    def test_every_documented_cli_example_in_docs_parses_and_executes_cleanly(self) -> None:
        self.assertTrue(DOCS_FILE.is_file(), f"missing documentation file: {DOCS_FILE}")
        doc_text = DOCS_FILE.read_text(encoding="utf-8")

        blocks: list[str] = []
        in_bash = False
        current: list[str] = []
        for line in doc_text.splitlines():
            if line.strip().startswith("```bash"):
                in_bash = True
                current = []
                continue
            if in_bash and line.strip() == "```":
                in_bash = False
                blocks.append("\n".join(current))
                continue
            if in_bash:
                current.append(line)

        self.assertGreaterEqual(len(blocks), 6)

        commands: list[list[str]] = []
        for block in blocks:
            joined = block.replace("\\\n", " ")
            for raw_cmd in joined.splitlines():
                stripped = raw_cmd.strip()
                if not stripped or stripped.startswith(("#", "export ")):
                    continue
                commands.append(shlex.split(stripped))

        self.assertGreaterEqual(len(commands), 8)

        ctl_parser = ctl.build_parser()
        wp_parser = wp.build_parser()

        for argv in commands:
            prog = Path(argv[1]).name if argv[0] == "python3" else Path(argv[0]).name
            cli_args = argv[2:] if argv[0] == "python3" else argv[1:]
            if prog in ("kodera-ctl", "kodera_ctl.py"):
                self.assertIsNotNone(ctl_parser.parse_args(cli_args))
            elif prog == "webrtc_probe.py":
                self.assertIsNotNone(wp_parser.parse_args(cli_args))
            else:
                self.fail(f"unexpected executable in docs: {argv}")

        proc = subprocess.run(
            [str(HERE / "kodera-ctl"), "--selftest"],
            cwd=str(ROOT),
            shell=False,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("OK: kodera_ctl selftest passed", proc.stdout)

        doc_turn_pw = "doc-" + secrets.token_hex(8)
        with (
            tempfile.TemporaryDirectory(prefix="kodera-ctl-docs-exec-") as tmp,
            _MockIngressServer() as ingress,
            wp.EphemeralStunTurnServer(users={"kodera-turn": doc_turn_pw}) as turn_srv,
        ):
            stack = Path(tmp).resolve() / "stack"
            _populate_stack_dir(stack)
            env_file = stack / ".env"
            env_file.write_text(ctl._make_valid_test_env_text(), encoding="utf-8")
            env_file.chmod(0o600)
            runner = _RecordingRunner()

            with (
                mock.patch.object(ctl, "default_command_runner", runner),
                mock.patch.dict(os.environ, {"KODERA_TURN_PASSWORD": doc_turn_pw}),
            ):
                buf = io.StringIO()
                with mock.patch("sys.stdout", buf):
                    rc_probe = ctl.main(
                        [
                            "probe-webrtc",
                            "--domain",
                            "chat.example.org",
                            "--stun-host",
                            "127.0.0.1",
                            "--ports",
                            f"{turn_srv.port}",
                            "--public-ip",
                            "127.0.0.1",
                            "--turn-url",
                            f"turn:127.0.0.1:{turn_srv.port}?transport=udp",
                            "--turn-username",
                            "kodera-turn",
                            "--turn-password-env",
                            "KODERA_TURN_PASSWORD",
                            "--timeout",
                            "2.0",
                            "--json",
                        ]
                    )
                self.assertEqual(rc_probe, 0)
                self.assertEqual(json.loads(buf.getvalue())["status"], "turn_relay_verified")

                for sub_argv, expected_status in (
                    (
                        [
                            "upgrade",
                            "--env-file",
                            str(env_file),
                            "--stack-dir",
                            str(stack),
                            "--skip-preflight-http",
                            "--dry-run",
                            "--json",
                        ],
                        "dry_run",
                    ),
                    (
                        [
                            "upgrade",
                            "--env-file",
                            str(env_file),
                            "--stack-dir",
                            str(stack),
                            "--base-url",
                            ingress.base_url,
                            "--auto-rollback",
                            "--json",
                        ],
                        "upgraded",
                    ),
                    (
                        [
                            "status",
                            "--env-file",
                            str(env_file),
                            "--stack-dir",
                            str(stack),
                            "--base-url",
                            ingress.base_url,
                            "--json",
                        ],
                        "healthy",
                    ),
                    (
                        [
                            "rollback",
                            "--env-file",
                            str(env_file),
                            "--stack-dir",
                            str(stack),
                            "--base-url",
                            ingress.base_url,
                            "--backup",
                            "latest",
                            "--json",
                        ],
                        "rolled_back",
                    ),
                    (
                        [
                            "rehearse-restore",
                            "--env-file",
                            str(env_file),
                            "--stack-dir",
                            str(stack),
                            "--backup",
                            "latest",
                            "--json",
                        ],
                        "rehearsed",
                    ),
                ):
                    out = io.StringIO()
                    with mock.patch("sys.stdout", out):
                        rc = ctl.main(sub_argv)
                    self.assertEqual(rc, 0, out.getvalue())
                    self.assertEqual(json.loads(out.getvalue())["status"], expected_status)


class RehearseRestoreTests(unittest.TestCase):
    def _setup_stack_with_backup(self, tmp: str) -> tuple[Path, Path, str, _RecordingRunner]:
        stack = Path(tmp).resolve() / "stack"
        _populate_stack_dir(stack)
        env_file = stack / ".env"
        env_file.write_text(ctl._make_valid_test_env_text(), encoding="utf-8")
        env_file.chmod(0o600)
        runner = _RecordingRunner()
        ctx = ctl.preflight_stack(
            env_file=env_file,
            stack_dir=stack,
            skip_preflight_http=True,
            invoke_deploy_cli=False,
        )
        runner.caddy_open = False
        runner.writers_stopped = True
        rec = ctl.create_backup(ctx, runner=runner, backup_id_override="snap-rehearsal-01")
        manifest_path = rec.backup_dir / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["created_at"] = "2026-11-23T10:00:00Z"
        os.chmod(manifest_path, 0o600)
        manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        os.chmod(manifest_path, 0o600)
        runner.calls.clear()
        return stack, env_file, rec.backup_id, runner

    def test_rehearse_restore_isolates_network_strips_ports_runs_guards_and_measures_rpo_rto(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="kodera-ctl-rehearsal-") as tmp:
            stack, env_file, backup_id, runner = self._setup_stack_with_backup(tmp)
            inputs_dir = Path(tmp).resolve() / "inputs"
            inputs_dir.mkdir(mode=0o700)

            ledger_file = inputs_dir / "erasure-ledger.json"
            ledger_file.write_text(
                '{"backup_created_at":"2026-11-23T10:00:00Z","organisation_references":[],"user_references":[]}',
                encoding="utf-8",
            )
            ledger_file.chmod(0o600)

            s3_file = inputs_dir / "s3-manifest.json"
            s3_file.write_text('{"objects":[]}', encoding="utf-8")
            s3_file.chmod(0o600)

            kc_dump = inputs_dir / "keycloak.dump"
            kc_dump.write_bytes(runner.dbs["keycloak-db"].dump_archive())
            kc_dump.chmod(0o600)

            kc_realm = inputs_dir / "keycloak-realm.json"
            kc_realm.write_text('{"realm":"acme-corp","enabled":true}', encoding="utf-8")
            kc_realm.chmod(0o600)

            receipt_dir = Path(tmp).resolve() / "receipts"
            receipt_dir.mkdir(mode=0o700)
            receipt_path = receipt_dir / "drill-receipt.json"

            ticks = iter([100.0, 142.375])
            report = ctl.execute_rehearse_restore(
                env_file=env_file,
                stack_dir=stack,
                backup_selector=backup_id,
                rehearsal_id="drill42",
                erasure_ledger=ledger_file,
                s3_manifest=s3_file,
                keycloak_dump=kc_dump,
                keycloak_realm_export=kc_realm,
                reference_timestamp="2026-11-23T10:15:00Z",
                receipt_out=receipt_path,
                runner=runner,
                monotonic_clock=lambda: next(ticks),
                invoke_deploy_cli=False,
            )

            self.assertEqual(report["status"], "rehearsed")
            self.assertEqual(report["rehearsal_project"], "kodera-rehearsal-drill42")
            self.assertEqual(report["rpo_seconds"], 900)
            self.assertEqual(report["rto_seconds"], 42.375)
            self.assertTrue(report["egress_isolated"])
            self.assertEqual(report["public_ports_bound"], 0)
            self.assertTrue(report["teardown_completed"])
            self.assertEqual(report["restored_databases"], ["kodera_server", "synapse", "keycloak"])
            self.assertEqual(report["keycloak_snapshot"]["realm"], "acme-corp")  # type: ignore[index]

            # Receipt file exists with mode 0600 and matches report.
            self.assertTrue(receipt_path.is_file())
            self.assertEqual(stat.S_IMODE(os.lstat(receipt_path).st_mode), 0o600)
            disk_receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            self.assertEqual(disk_receipt["rpo_seconds"], 900)
            self.assertEqual(disk_receipt["rto_seconds"], 42.375)

            # Verify override YAML enforced internal: true networks, zero host ports,
            # distinct `migrate` operator image (`P1-1`), ephemeral DB roles (`P1-2`),
            # container-owned named volume without host bind mount (`P1-3`), and kill-switches (`P2-6`).
            ov = runner.captured_rehearsal_override or ""
            self.assertIn("internal: true", ov)
            self.assertIn("ports: !reset []", ov)
            self.assertIn("keycloak-db:", ov)
            self.assertIn(f"  migrate:\n    image: {_service_sha256('migrate')}", ov)
            self.assertNotEqual(_service_sha256("migrate"), _service_sha256("server"))
            self.assertIn("rehearsal_guards:/run/kodera-rehearsal:ro", ov)
            self.assertNotIn(str(inputs_dir), ov)
            self.assertIn('KODERA_REHEARSAL_NO_EGRESS: "1"', ov)
            self.assertIn('KODERA_STRIPE_SECRET_KEY: ""', ov)
            self.assertIn('KODERA_MAIL_SMTP_URL: ""', ov)
            self.assertIn('KODERA_GITHUB_TRIAGE_REPO: ""', ov)
            self.assertIn("postgresql://kodera_api:", ov)
            self.assertIn("postgresql://kodera_collab:", ov)

            # Restricted roles `kodera_api` and `kodera_collab` were provisioned BEFORE `pg_restore` (`P1-2`).
            self.assertTrue(runner.roles_created_before_db_restore)
            self.assertEqual(len(runner.bootstrapped_role_sql), 1)
            self.assertIn("NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT", runner.bootstrapped_role_sql[0])

            # Guard files were streamed via tar owned `10001:10001` mode `0400` (`P1-3`).
            self.assertEqual(
                set(runner.streamed_guard_tar_members),
                {"erasure-ledger.json", "s3-manifest.json"},
            )
            for _, (uid, gid, mode, payload) in runner.streamed_guard_tar_members.items():
                self.assertEqual((uid, gid, mode), (10001, 10001, 0o400))
                self.assertTrue(payload)

            # Single-descriptor staged bytes fed to `pg_restore` match backup dump (`P2-9`).
            self.assertEqual(
                hashlib.sha256(runner.pg_restore_payloads["keycloak-db"]).hexdigest(),
                report["keycloak_snapshot"]["sha256"],  # type: ignore[index]
            )

            # Every docker compose command used `-p kodera-rehearsal-drill42`, caddy never started,
            # rehearse_restore_guards ran BEFORE server/synapse started, and down -v ran last!
            compose_calls = [c for c in runner.calls if c[:2] == ["docker", "compose"]]
            self.assertTrue(compose_calls)
            for c in compose_calls:
                self.assertIn("-p", c)
                self.assertEqual(c[c.index("-p") + 1], "kodera-rehearsal-drill42")
                self.assertFalse("up" in c and "caddy" in c)

            guard_idx = next(
                i for i, c in enumerate(compose_calls) if "rehearse_restore_guards" in c
            )
            server_up_idx = next(
                i for i, c in enumerate(compose_calls) if "up" in c and c[-1] == "server"
            )
            self.assertLess(guard_idx, server_up_idx)
            self.assertIn("--disarm-outbound", compose_calls[guard_idx])
            self.assertIn("--erasure-ledger", compose_calls[guard_idx])
            self.assertIn("--s3-manifest", compose_calls[guard_idx])
            self.assertEqual(compose_calls[-1][-3:], ["down", "-v", "--remove-orphans"])

    def test_rehearsal_unconditionally_tears_down_on_guard_or_readiness_failure(self) -> None:
        with tempfile.TemporaryDirectory(prefix="kodera-ctl-rehearsal-fail-") as tmp:
            stack, env_file, backup_id, runner = self._setup_stack_with_backup(tmp)

            # 1. Guard failure (e.g. S3 manifest mismatch or residual PII) -> tears down in finally!
            runner.fail_restore_guards = True
            with self.assertRaises(ctl.CtlRehearsalError) as ctx_guard:
                ctl.execute_rehearse_restore(
                    env_file=env_file,
                    stack_dir=stack,
                    backup_selector=backup_id,
                    rehearsal_id="guardfail",
                    runner=runner,
                    invoke_deploy_cli=False,
                )
            self.assertIn("rehearsal-restore-guards failed", str(ctx_guard.exception))
            self.assertEqual(runner.calls[-1][-3:], ["down", "-v", "--remove-orphans"])

            # 2. Internal readiness failure -> tears down in finally!
            runner.calls.clear()
            runner.fail_restore_guards = False
            runner.fail_rehearsal_readiness = True
            with self.assertRaises(ctl.CtlRehearsalError) as ctx_ready:
                ctl.execute_rehearse_restore(
                    env_file=env_file,
                    stack_dir=stack,
                    backup_selector=backup_id,
                    rehearsal_id="readyfail",
                    runner=runner,
                    invoke_deploy_cli=False,
                )
            self.assertIn("internal-server-readiness failed", str(ctx_ready.exception))
            self.assertEqual(runner.calls[-1][-3:], ["down", "-v", "--remove-orphans"])

            # 3. Teardown failure itself fails closed!
            runner.calls.clear()
            runner.fail_rehearsal_readiness = False
            runner.fail_rehearsal_teardown = True
            with self.assertRaises(ctl.CtlRehearsalError) as ctx_td:
                ctl.execute_rehearse_restore(
                    env_file=env_file,
                    stack_dir=stack,
                    backup_selector=backup_id,
                    rehearsal_id="tdfail",
                    runner=runner,
                    invoke_deploy_cli=False,
                )
            self.assertIn("teardown failed", str(ctx_td.exception))

    def test_rehearsal_refuses_symlinks_insecure_permissions_and_negative_rpo_before_containers(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="kodera-ctl-rehearsal-refuse-") as tmp:
            stack, env_file, backup_id, runner = self._setup_stack_with_backup(tmp)
            work = Path(tmp).resolve() / "work"
            work.mkdir(mode=0o700)

            # 1. Negative RPO refused before starting any container.
            with self.assertRaises(ctl.CtlRehearsalError):
                ctl.execute_rehearse_restore(
                    env_file=env_file,
                    stack_dir=stack,
                    backup_selector=backup_id,
                    reference_timestamp="2026-11-23T09:59:59Z",
                    runner=runner,
                    invoke_deploy_cli=False,
                )
            self.assertEqual([c for c in runner.calls if "up" in c], [])

            # 2. World-readable (0644) erasure ledger refused before starting any container.
            bad_mode_ledger = work / "world.json"
            bad_mode_ledger.write_text(
                '{"backup_created_at":"2026-11-23T10:00:00Z"}', encoding="utf-8"
            )
            bad_mode_ledger.chmod(0o644)
            with self.assertRaises(ctl.CtlRehearsalError) as ctx_perm:
                ctl.execute_rehearse_restore(
                    env_file=env_file,
                    stack_dir=stack,
                    backup_selector=backup_id,
                    erasure_ledger=bad_mode_ledger,
                    runner=runner,
                    invoke_deploy_cli=False,
                )
            self.assertIn("0600", str(ctx_perm.exception))
            self.assertEqual([c for c in runner.calls if "up" in c], [])

            # 3. Symlinked S3 manifest refused before starting any container.
            real_s3 = work / "real-s3.json"
            real_s3.write_text('{"objects":[]}', encoding="utf-8")
            real_s3.chmod(0o600)
            link_s3 = work / "link-s3.json"
            link_s3.symlink_to(real_s3)
            with self.assertRaises(ctl.CtlRehearsalError):
                ctl.execute_rehearse_restore(
                    env_file=env_file,
                    stack_dir=stack,
                    backup_selector=backup_id,
                    s3_manifest=link_s3,
                    runner=runner,
                    invoke_deploy_cli=False,
                )
            self.assertEqual([c for c in runner.calls if "up" in c], [])

            # 4. Invalid rehearsal_id refused.
            with self.assertRaises(ctl.CtlRehearsalError):
                ctl.execute_rehearse_restore(
                    env_file=env_file,
                    stack_dir=stack,
                    backup_selector=backup_id,
                    rehearsal_id="../escape",
                    runner=runner,
                    invoke_deploy_cli=False,
                )

            # 5. Ancestor directory symlink refused via retained `dir_fd` walk (`P2-8`).
            real_sub = work / "real-sub"
            real_sub.mkdir(mode=0o700)
            nested_s3 = real_sub / "s3.json"
            nested_s3.write_text('{"objects":[]}', encoding="utf-8")
            nested_s3.chmod(0o600)
            linked_sub = work / "linked-sub"
            linked_sub.symlink_to(real_sub)
            with self.assertRaises(ctl.CtlRehearsalError):
                ctl.execute_rehearse_restore(
                    env_file=env_file,
                    stack_dir=stack,
                    backup_selector=backup_id,
                    s3_manifest=linked_sub / "s3.json",
                    runner=runner,
                    invoke_deploy_cli=False,
                )
            self.assertEqual([c for c in runner.calls if "up" in c], [])

            # 6. Missing operator `migrate` image refuses cleanly instead of using `server` (`P1-1`).
            runner_no_mig = _RecordingRunner(missing_local_images={_service_sha256("migrate")})
            with self.assertRaisesRegex(ctl.CtlRehearsalError, "migrate"):
                ctl.execute_rehearse_restore(
                    env_file=env_file,
                    stack_dir=stack,
                    backup_selector=backup_id,
                    runner=runner_no_mig,
                    invoke_deploy_cli=False,
                )
            self.assertEqual([c for c in runner_no_mig.calls if "up" in c], [])

            # 7. Legacy manifest omitting `migrate` resolves stack's local `migrate` image (`P1-1`).
            manifest_path = stack / ctl.BACKUP_DIR_NAME / backup_id / "manifest.json"
            os.chmod(manifest_path, 0o600)
            legacy_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            legacy_manifest["images"].pop("migrate", None)
            manifest_path.write_text(
                json.dumps(legacy_manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )
            os.chmod(manifest_path, 0o600)
            legacy_runner = _RecordingRunner()
            legacy_res = ctl.execute_rehearse_restore(
                env_file=env_file,
                stack_dir=stack,
                backup_selector=backup_id,
                rehearsal_id="legacymig",
                runner=legacy_runner,
                invoke_deploy_cli=False,
            )
            self.assertEqual(legacy_res["status"], "rehearsed")
            self.assertIn(
                f"  migrate:\n    image: {_service_sha256('migrate')}",
                legacy_runner.captured_rehearsal_override or "",
            )


if __name__ == "__main__":
    unittest.main()
