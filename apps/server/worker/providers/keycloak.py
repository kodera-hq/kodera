"""The realm_create provider: identity realm tooling's realm-apply.sh, run one catalogue step at a time.

identity realm tooling is the identity implementation and Core consumes it (workspace rule, Core ADR-0006):
the worker runs the script vendored at worker/vendor/keycloak/, at the commit PIN.json names, and
refuses to run it when a vendored file's sha256 differs from the pin. The script drives Keycloak
through kcadm, which only the worker image carries (Dockerfile.worker).

It signs in as `kodera-realm-creator`, the master client that may create a realm and nothing else
(identity realm tooling DEPLOY.md). The script reads that client's secret, and step 5's SMTP password, from
the files this module names in its environment: a path is all that crosses into the child, never a
value, on argv or in the environment, so a process listing or an environment dump shows no secret.

A step completes only on exit status 0 with exactly one `run-record {json}` line on stdout whose
step, name, run id and realm are the ones that ran; anything else raises RealmApplyError, whatever
the record says. The record is evidence, never a decision: its `outcome`, `note` and observations
decide nothing, and the issuer is read only for the realm it names. It is kept bounded in size, cut
to the known keys, with the admin URL stripped of anything but its scheme, host, port and path, and
is stored as opaque JSON: whatever shows it to a person escapes it. stderr is the script's
diagnostics; it is kept off the error's message, since a Keycloak refusal may quote what was sent.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

VENDOR = Path(__file__).resolve().parent.parent / "vendor" / "keycloak"
SCRIPT = "realm-apply.sh"
TEMPLATE = "org-realm-template.json"
CREATOR_CLIENT_ID = "kodera-realm-creator"
TARGET = "staging"

# The catalogue's realm_create steps (apps/jobs/kinds.py) and realm-apply.sh's numbered steps.
STEPS: Mapping[str, int] = {
    "create_realm": 1,
    "create_clients": 2,
    "create_service_account": 3,
    "configure_idp": 4,
    "configure_smtp": 5,
    "apply_theme": 6,
    "verify": 7,
}
SMTP_STEP = "configure_smtp"

# realm-apply.sh's own rule for --run-id; an organisation slug as Core's contract allows it. Both
# start with an alphanumeric, so neither can be read as an option.
RUN_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
SLUG = re.compile(r"[a-z0-9][a-z0-9-]{0,62}")

RECORD_PREFIX = "run-record "
RECORD_KEYS = frozenset(
    {
        "run_id",
        "step",
        "name",
        "outcome",
        "issuer",
        "admin_url",
        "compute_terminated",
        "target_read",
    }
)
OBSERVATION_KEYS = ("provider", "resource_id", "request_id", "observed_at")
DIAGNOSTICS_TAIL = 4096
# A run record is about 700 bytes; a line this long is not one.
MAX_RECORD_BYTES = 8192


class VendorMismatchError(Exception):
    """A vendored file is missing or differs from PIN.json. The message names the file."""


class RealmApplyError(Exception):
    """A step did not complete. The message names the step and why, never what the script printed."""

    def __init__(
        self, message: str, *, exit_code: int | None = None, diagnostics: str = ""
    ) -> None:
        super().__init__(message)
        self.exit_code = exit_code
        # The tail of the script's stderr, for an operator to read; never logged by this module.
        self.diagnostics = diagnostics


@dataclass(frozen=True)
class Target:
    """Where and as whom: the admin URL and the paths of the two secret files, not their contents."""

    admin_url: str
    creator_secret_file: Path
    smtp_user: str = field(default="")
    smtp_password_file: Path | None = None


@dataclass(frozen=True)
class Evidence:
    """One completed step, as the run record says it, ready to store with the step's outcome."""

    step: str
    record: Mapping[str, Any]


def verify_vendored(vendor: Path = VENDOR) -> Mapping[str, Any]:
    """Refuse unless every file PIN.json lists is present with the pinned sha256; return the pin."""
    try:
        pin: dict[str, Any] = json.loads((vendor / "PIN.json").read_text(encoding="utf-8"))
        files = pin["files"]
    except (OSError, ValueError, KeyError, TypeError):
        raise VendorMismatchError("PIN.json is unreadable") from None
    if set(files) != {SCRIPT, TEMPLATE}:
        raise VendorMismatchError(f"PIN.json must pin exactly {SCRIPT} and {TEMPLATE}")
    for name, entry in files.items():
        try:
            digest = hashlib.sha256((vendor / name).read_bytes()).hexdigest()
        except OSError:
            raise VendorMismatchError(f"{name} is not vendored") from None
        if digest != entry.get("sha256"):
            raise VendorMismatchError(f"{name} differs from the pinned commit {pin.get('commit')}")
    return pin


def command(
    step: str, *, run_id: str, realm: str, docs: bool, visio: bool, vendor: Path = VENDOR
) -> list[str]:
    """The argv of one step. Every value on it is public: no secret is ever an argument."""
    if step not in STEPS:
        raise RealmApplyError(f"{step} is not a realm_create step")
    if RUN_ID.fullmatch(run_id) is None:
        raise RealmApplyError("the run id is not one realm-apply.sh accepts")
    if SLUG.fullmatch(realm) is None:
        raise RealmApplyError("the realm is not an organisation slug")
    if step == "verify":
        head = ["verify"]
    else:
        head = ["step", str(STEPS[step])]
    argv = ["bash", str(vendor / SCRIPT), *head, "--target", TARGET, "--run-id", run_id]
    argv += ["--file", str(vendor / TEMPLATE), "--realm", realm]
    if docs:
        argv.append("--docs")
    if visio:
        argv.append("--visio")
    return argv


def environment(step: str, target: Target, home: Path) -> dict[str, str]:
    """The child's whole environment: built here, never inherited, so nothing else leaks into it."""
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(home),
        "LANG": "C.UTF-8",
        "KC_SERVER": target.admin_url,
        "KC_CLIENT_ID": CREATOR_CLIENT_ID,
        "KC_CLIENT_SECRET_FILE": str(target.creator_secret_file),
    }
    for name in ("JAVA_HOME", "KCADM"):
        if name in os.environ:
            env[name] = os.environ[name]
    if step == SMTP_STEP:
        if not target.smtp_user or target.smtp_password_file is None:
            raise RealmApplyError("configure_smtp needs the realm's SMTP user and password file")
        env["SMTP_USER"] = target.smtp_user
        env["SMTP_PASSWORD_FILE"] = str(target.smtp_password_file)
    return env


def _public_url(value: str) -> str:
    # The admin URL the run reached, as evidence: scheme, host, port and path, and nothing a
    # credential could ride in (userinfo, query, fragment).
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise RealmApplyError("the run record's admin_url is not a URL")
    host = parts.hostname if parts.port is None else f"{parts.hostname}:{parts.port}"
    return urlunsplit((parts.scheme, host, parts.path, "", ""))


def parse_record(stdout: str, *, step: str, run_id: str, realm: str) -> Evidence:
    """The step's one run record, checked against the step that ran and cut to the known keys."""
    lines = [line for line in stdout.splitlines() if line.startswith(RECORD_PREFIX)]
    if len(lines) != 1:
        raise RealmApplyError(f"{step} printed {len(lines)} run records, not one")
    if len(lines[0].encode("utf-8")) > MAX_RECORD_BYTES:
        raise RealmApplyError(f"{step}'s run record is longer than {MAX_RECORD_BYTES} bytes")
    try:
        raw = json.loads(lines[0][len(RECORD_PREFIX) :])
    except ValueError:
        raise RealmApplyError(f"{step}'s run record is not JSON") from None
    if not isinstance(raw, dict):
        raise RealmApplyError(f"{step}'s run record is not an object")
    # What ran, and nothing the script reports about it: `outcome` is not read, exit status 0 is.
    expected = {"run_id": run_id, "step": STEPS[step], "name": step}
    for key, value in expected.items():
        if raw.get(key) != value:
            raise RealmApplyError(f"{step}'s run record does not match the step on {key}")
    issuer = raw.get("issuer")
    if not isinstance(issuer, str) or urlsplit(issuer).path != f"/realms/{realm}":
        raise RealmApplyError(f"{step}'s run record does not match the step on realm")
    record: dict[str, Any] = {key: raw[key] for key in sorted(RECORD_KEYS) if key in raw}
    for key in ("compute_terminated", "target_read"):
        seen = record.get(key)
        if not isinstance(seen, dict):
            raise RealmApplyError(f"{step}'s run record has no {key}")
        record[key] = {name: str(seen[name]) for name in OBSERVATION_KEYS if name in seen}
    if "admin_url" in record:
        record["admin_url"] = _public_url(str(record["admin_url"]))
    return Evidence(step, record)


def run_step(
    step: str,
    *,
    run_id: str,
    realm: str,
    target: Target,
    timeout: float,
    docs: bool = False,
    visio: bool = False,
    vendor: Path = VENDOR,
) -> Evidence:
    """Run one step to its end and return its evidence, or raise RealmApplyError."""
    verify_vendored(vendor)
    argv = command(step, run_id=run_id, realm=realm, docs=docs, visio=visio, vendor=vendor)
    with tempfile.TemporaryDirectory(prefix="realm-apply-") as scratch:
        home = Path(scratch)
        env = environment(step, target, home)
        # In the caller's process group, never a session of its own: in the worker that is the step
        # child's group, which the runner kills whole when the step ends (worker/child.py), so the
        # script's kcadm and its JVM go with it.
        with subprocess.Popen(  # noqa: S603 - the pinned script, arguments checked above
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=home,
            env=env,
        ) as child:
            try:
                stdout, stderr = child.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                # The script goes now. Not waiting on its pipes: a JVM it started may hold them
                # until the runner's group kill.
                child.kill()
                child.wait()
                raise RealmApplyError(f"{step} did not finish within {timeout:g} s") from None
    if child.returncode != 0:
        raise RealmApplyError(
            f"{step} failed with exit status {child.returncode}",
            exit_code=child.returncode,
            diagnostics=stderr[-DIAGNOSTICS_TAIL:].decode("utf-8", "replace"),
        )
    return parse_record(stdout.decode("utf-8", "replace"), step=step, run_id=run_id, realm=realm)
