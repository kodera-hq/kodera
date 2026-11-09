"""Enumerate required acceptance without certifying unimplemented behavior.

No credential, manifest-supplied command or scenario plugin is admitted. One checked-in
driver is: `dev/first_slice_bootstrap.py`, whose path is fixed in `DRIVEN` and which may
report FS-BOOT-01..07 only as `failed` or `blocked`. `driven` refuses every other shape by a
named reason, so a driver that starts passing, drops a case, downgrades a status or omits its
assertion blocks the whole run instead of relaying a result this process cannot check. Absent
driver, those cases stay `not_implemented`, which is what they are in a tree without one.
"""

import argparse
import hashlib
import json
import os
import selectors
import stat
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Never

REQUIRED = tuple(
    f"FS-{group}-{number:02}"
    for group, count in [
        ("BOOT", 7),
        ("LIFE", 3),
        ("ID", 3),
        ("OP", 6),
        ("CON", 6),
        ("BILL", 6),
        ("JOURNEY", 1),
        ("HARNESS", 1),
    ]
    for number in range(1, count + 1)
)
MANIFEST_LIMIT = 262144
SOURCE_LIMIT = 64 * 1024 * 1024
# Scenario statuses, least to most severe. `passed` is deliberately not a member: this runner
# has no way to certify product behavior and must never learn one from a subprocess.
STATUSES = ("not_implemented", "blocked", "failed")
DRIVEN = ("dev/first_slice_bootstrap.py", tuple(f"FS-BOOT-{number:02}" for number in range(1, 8)))
DRIVER_LIMIT = 4 * 1024 * 1024
DRIVER_SECONDS = 1800


class AdmissionError(Exception):
    """A named refusal that never includes supplied contents."""


def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def reject_constant(value: str) -> None:
    raise ValueError("non-JSON constant")


def manifest(root: Path) -> tuple[dict[str, str], str]:
    try:
        path = root / "dev/first_slice_manifest.json"
        before = path.lstat()
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("nonregular manifest")
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as handle:
            opened = os.fstat(handle.fileno())
            if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (
                before.st_dev,
                before.st_ino,
            ):
                raise ValueError("changed manifest")
            raw = handle.read(MANIFEST_LIMIT + 1)
        if len(raw) > MANIFEST_LIMIT:
            raise ValueError("oversized manifest")
        data = json.loads(raw, object_pairs_hook=unique_object, parse_constant=reject_constant)
        if not isinstance(data, dict) or set(data) != {"format", "scenarios"}:
            raise ValueError("manifest fields")
        if type(data["format"]) is not int or data["format"] != 1:
            raise ValueError("manifest format")
        rows = data["scenarios"]
        if not isinstance(rows, list) or len(rows) != len(REQUIRED):
            raise ValueError("scenario population")
        found: dict[str, str] = {}
        for row in rows:
            if not isinstance(row, dict) or set(row) != {"id", "description"}:
                raise ValueError("scenario fields")
            name, description = row["id"], row["description"]
            if not isinstance(name, str) or name not in REQUIRED or name in found:
                raise ValueError("scenario identity")
            if not isinstance(description, str) or not description.strip():
                raise ValueError("scenario description")
            found[name] = description
        if set(found) != set(REQUIRED):
            raise ValueError("scenario population")
        return found, hashlib.sha256(raw).hexdigest()
    except (OSError, ValueError, RecursionError) as exc:
        raise AdmissionError("invalid_manifest") from exc


def git(root: Path, *args: str) -> bytes:
    """Bound both streams while Git runs; never expose its error contents."""
    output = bytearray()
    used = 0
    try:
        # Fixed program and locally declared arguments, never manifest commands.
        with subprocess.Popen(  # noqa: S603
            ["git", "-c", "core.fsmonitor=false", *args],  # noqa: S607
            cwd=root,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        ) as process:
            try:
                with selectors.DefaultSelector() as selector:
                    if process.stdout is None or process.stderr is None:
                        raise ValueError("missing capture streams")
                    for stream in [process.stdout, process.stderr]:
                        os.set_blocking(stream.fileno(), False)
                        selector.register(stream, selectors.EVENT_READ)
                    deadline = time.monotonic() + 10
                    while selector.get_map():
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            raise ValueError("capture deadline")
                        for key, _ in selector.select(min(remaining, 0.1)):
                            chunk = os.read(key.fd, 65536)
                            if not chunk:
                                selector.unregister(key.fileobj)
                                continue
                            used += len(chunk)
                            if used > SOURCE_LIMIT:
                                raise ValueError("oversized git capture")
                            if key.fileobj is process.stdout:
                                output.extend(chunk)
                    if process.wait(timeout=max(0.01, deadline - time.monotonic())):
                        raise ValueError("git refused capture")
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=2)
        return bytes(output)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        raise AdmissionError("source_unavailable") from exc


def source(root: Path, admitted_manifest: str | None = None) -> dict[str, Any]:
    try:
        top = Path(os.fsdecode(git(root, "rev-parse", "--show-toplevel").strip()))
        if top.resolve() != root.resolve():
            raise ValueError("wrong repository")
        commit = git(root, "rev-parse", "--verify", "HEAD").decode().strip()
        state = git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all")
        index = git(root, "ls-files", "--stage", "-z")
        paths = git(root, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
        digest = hashlib.sha256()
        used = 0
        captured: dict[Path, os.stat_result | None] = {}
        captured_manifest: str | None = None

        def identity(value: os.stat_result | None) -> tuple[int, ...] | None:
            if value is None:
                return None
            return (
                value.st_dev,
                value.st_ino,
                value.st_mode,
                value.st_size,
                value.st_mtime_ns,
                value.st_ctime_ns,
            )

        def capture(value: bytes) -> None:
            nonlocal used
            used += len(value)
            if used > SOURCE_LIMIT:
                raise ValueError("oversized source")
            digest.update(len(value).to_bytes(8, "big"))
            digest.update(value)

        capture(commit.encode())
        capture(index)
        for raw_path in sorted(set(paths.split(b"\0")) - {b""}):
            relative = Path(os.fsdecode(raw_path))
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError("outside source")
            capture(raw_path)
            path = root / relative
            if any((root / parent).is_symlink() for parent in relative.parents):
                raise ValueError("linked source parent")
            try:
                before = path.lstat()
            except FileNotFoundError:
                captured[path] = None
                capture(b"deleted")
                continue
            captured[path] = before
            capture(str(stat.S_IFMT(before.st_mode) | stat.S_IMODE(before.st_mode)).encode())
            if stat.S_ISLNK(before.st_mode):
                capture(os.fsencode(os.readlink(path)))
            elif stat.S_ISREG(before.st_mode):
                with os.fdopen(
                    os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb"
                ) as handle:
                    opened = os.fstat(handle.fileno())
                    if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (
                        before.st_dev,
                        before.st_ino,
                    ):
                        raise ValueError("changed source")
                    file_digest = hashlib.sha256()
                    while chunk := handle.read(65536):
                        capture(chunk)
                        file_digest.update(chunk)
                    if relative.as_posix() == "dev/first_slice_manifest.json":
                        captured_manifest = file_digest.hexdigest()
                    after = os.fstat(handle.fileno())
                    if (opened.st_size, opened.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                        raise ValueError("changed source")
            else:
                raise ValueError("unsupported source node")
        if (
            index != git(root, "ls-files", "--stage", "-z")
            or state != git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all")
            or commit != git(root, "rev-parse", "--verify", "HEAD").decode().strip()
        ):
            raise ValueError("changed repository")
        if paths != git(root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"):
            raise ValueError("changed source population")
        for path, prior in captured.items():
            try:
                current = path.lstat()
            except FileNotFoundError:
                current = None
            if identity(prior) != identity(current):
                raise ValueError("changed source after read")
        if admitted_manifest is not None and captured_manifest != admitted_manifest:
            raise ValueError("changed admitted manifest")
        return {
            "commit": commit,
            "dirty": bool(state),
            "fingerprint": digest.hexdigest(),
            "fingerprint_scope": "index and tracked/untracked nonignored source; no runtime inputs",
            "capture_limit": "stability checked before report; not an atomic filesystem snapshot",
        }
    except (OSError, ValueError) as exc:
        raise AdmissionError("source_unavailable") from exc


def admitted_status(value: object) -> str:
    """The only status a driver may report. `passed` is not a member, and never becomes one."""
    if value not in {"failed", "blocked"}:
        raise AdmissionError("bootstrap_status_not_admitted")
    return str(value)


def severity(status: str) -> int:
    """Rank for the roll-up, and the second place an unadmitted status is refused by name."""
    if status not in STATUSES:
        raise AdmissionError("bootstrap_status_not_admitted")
    return STATUSES.index(status)


def driven(root: Path, selected: list[str]) -> dict[str, Any] | None:
    """Run the checked-in bootstrap driver and refuse any report weaker than it promises.

    Absent driver: the cases stay `not_implemented`, which is what they are in a tree that
    holds no driver. Present driver: every refusal below is fail-closed, because the one thing
    this runner must never do is relay a passing product result it cannot check.
    """
    path, cases = DRIVEN
    driver, driven_cases = root / path, [name for name in selected if name in cases]
    if not driven_cases or not driver.is_file() or driver.is_symlink():
        return None
    environment = {
        key: os.environ[key]
        for key in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL")
        if key in os.environ
    }
    # A constructed environment, never the caller's: config.environment refuses SSH agents,
    # secrets-file references and identity admin variables, and forwarding them would turn a
    # product verdict into an environment accident.
    environment["PYTHONPATH"] = str(root)
    environment["DJANGO_SETTINGS_MODULE"] = "config.settings.test"
    environment["DJANGO_SECRET_KEY"] = "synthetic-acceptance-key"  # noqa: S105 - synthetic local fixture
    arguments = [argument for name in driven_cases for argument in ("--case", name)]
    try:
        # Fixed interpreter and a checked-in driver of this repository; no manifest command.
        result = subprocess.run(  # noqa: S603
            [sys.executable, str(driver), *arguments],
            cwd=root,
            env=environment,
            capture_output=True,
            text=True,
            timeout=DRIVER_SECONDS,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise AdmissionError("bootstrap_driver_unavailable") from exc
    if result.returncode != 1 or len(result.stdout) > DRIVER_LIMIT:
        raise AdmissionError("bootstrap_driver_unavailable")
    try:
        report = json.loads(
            result.stdout, object_pairs_hook=unique_object, parse_constant=reject_constant
        )
    except (ValueError, RecursionError) as exc:
        raise AdmissionError("bootstrap_report_invalid") from exc
    if not isinstance(report, dict) or set(report) != {
        "format",
        "runtime_admission",
        "dependencies",
        "scenarios",
    }:
        raise AdmissionError("bootstrap_report_invalid")
    if type(report["format"]) is not int or report["format"] != 1:
        raise AdmissionError("bootstrap_report_invalid")
    rows = report["scenarios"]
    if (
        not isinstance(rows, list)
        or [
            row["id"] if isinstance(row, dict) and isinstance(row.get("id"), str) else None
            for row in rows
        ]
        != driven_cases
    ):
        raise AdmissionError("bootstrap_selection_incomplete")
    for row in rows:
        if set(row) != {"id", "status", "observed_assertions"}:
            raise AdmissionError("bootstrap_report_invalid")
        admitted_status(row["status"])
        assertions = row["observed_assertions"]
        if not isinstance(assertions, list) or not assertions:
            raise AdmissionError("bootstrap_assertion_missing")
        if any(not isinstance(item, str) or not item.strip() for item in assertions):
            raise AdmissionError("bootstrap_assertion_missing")
    if not isinstance(report["runtime_admission"], str) or not isinstance(
        report["dependencies"], dict
    ):
        raise AdmissionError("bootstrap_report_invalid")
    return report


class RedactedParser(argparse.ArgumentParser):
    def error(self, message: str) -> Never:
        raise AdmissionError("invalid_arguments")


def main() -> int:
    try:
        parser = RedactedParser(description=__doc__)
        parser.add_argument("--case", default=os.environ.get("CASE", ""))
        args = parser.parse_args()
        if args.case and args.case not in REQUIRED:
            raise AdmissionError("unknown_scenario")
        root = Path(__file__).resolve().parents[1]
        rows, manifest_digest = manifest(root)
        selected = [args.case] if args.case else list(REQUIRED)
        driver = driven(root, selected)
        observed = {row["id"]: row for row in (driver or {}).get("scenarios", [])}
        scenarios = [
            {
                "id": name,
                "description": rows[name],
                "status": observed.get(name, {}).get("status", "not_implemented"),
                "observed_assertions": observed.get(name, {}).get("observed_assertions", []),
            }
            for name in selected
        ]
        limitations = [
            "Superseded for scenario state: tests/first_slice/scenarios.toml is authoritative, "
            "and make first-slice-scenarios enforces it; this report remains the evidence and "
            "entry-point record.",
            "Inventory only for every scenario still reported not_implemented.",
            "Entry-point unit tests do not satisfy FS-HARNESS-01.",
            "Full first-slice and customer-release gates remain unmet.",
        ]
        if driver is not None:
            limitations.insert(
                0,
                "FS-BOOT-01..07 are driven against the real settings, migrations, URL resolver "
                "and DRF stack; each is red because the behavior is absent, and none of them "
                "reaches the discrimination its scenario is ultimately about. See "
                "docs/specs/FIRST_OWNER_BOOTSTRAP.md §11.",
            )
        report = {
            "format": 1,
            "status": max(
                (row["status"] for row in scenarios),
                key=severity,
                default="not_implemented",
            ),
            "scope": "partial" if args.case else "full",
            "source": source(root, manifest_digest),
            "manifest_sha256": manifest_digest,
            "selected": selected,
            "command": [
                "make",
                "acceptance-first-slice",
                f"CASE={args.case}",
            ],
            "fixture_seed": "first-slice-synthetic-v1",
            "python": sys.version.split()[0],
            "dependencies": (driver or {}).get(
                "dependencies", {"observation": "not_probed", "versions": {}}
            ),
            "runtime_admission": (driver or {}).get("runtime_admission", "not_implemented"),
            "scenarios": scenarios,
            "limitations": limitations,
        }
        print(json.dumps(report, indent=2))
        return 1
    except AdmissionError as exc:
        print(json.dumps({"format": 1, "status": "blocked", "reason": str(exc)}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
