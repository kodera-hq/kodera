#!/usr/bin/env python3
"""Prove UUID synchronization acceptance catches two precise weakenings offline."""

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "core/db/ids.py"
CASES = (
    (
        "missing-call-lock",
        "    with _generation_lock:\n        return uuid6.uuid7()",
        "    return uuid6.uuid7()",
        "test_full_dependency_call_is_serialized",
        "shared UUID dependency calls overlapped",
    ),
    (
        "missing-child-reset",
        "os.register_at_fork(after_in_child=_reset_child_lock)",
        "# Child reset deliberately removed by acceptance mutation.",
        "test_child_replaces_inherited_held_lock",
        "child UUID generation did not make bounded progress",
    ),
)


def probe(root: Path, node: str) -> subprocess.CompletedProcess[str]:
    # Only a fixed local test process: no inherited infrastructure configuration,
    # provider credentials, database URL, proxy, or test-runner flags.
    environment = {
        "PATH": os.defpath,
        "PYTHONPATH": str(root),
        "PYTHONDONTWRITEBYTECODE": "1",
        "DJANGO_SETTINGS_MODULE": "config.settings.dev",
    }
    return subprocess.run(  # noqa: S603
        [
            sys.executable,
            "-m",
            "pytest",
            "-q",
            "-c",
            str(root / "pyproject.toml"),
            str(root / "tests/test_customer_ids.py") + "::" + node,
        ],
        cwd=root,
        env=environment,
        capture_output=True,
        text=True,
        timeout=25,
        check=False,
    )


def main() -> None:
    original = SOURCE.read_text()
    for name, old, new, node, diagnostic in CASES:
        if original.count(old) != 1:
            raise RuntimeError(f"{name}: mutation target must occur exactly once")
        with tempfile.TemporaryDirectory(prefix="customer-ids-mutation-") as directory:
            root = Path(directory)
            shutil.copytree(ROOT / "core", root / "core", ignore=shutil.ignore_patterns("*.pyc"))
            shutil.copytree(
                ROOT / "config", root / "config", ignore=shutil.ignore_patterns("*.pyc")
            )
            shutil.copyfile(ROOT / "pyproject.toml", root / "pyproject.toml")
            shutil.copyfile(ROOT / "manage.py", root / "manage.py")
            (root / "tests").mkdir()
            shutil.copyfile(
                ROOT / "tests/test_customer_ids.py", root / "tests/test_customer_ids.py"
            )
            baseline = probe(root, node)
            if baseline.returncode != 0 or "1 passed" not in baseline.stdout:
                raise RuntimeError(f"{name}: exact selected baseline did not pass")
            (root / "core/db/ids.py").write_text(original.replace(old, new))
            result = probe(root, node)
            failures = [line for line in result.stdout.splitlines() if line.startswith("FAILED ")]
            if (
                result.returncode != 1
                or len(failures) != 1
                or not failures[0].split(" - ")[0].endswith(f"/tests/test_customer_ids.py::{node}")
                or f"AssertionError: {diagnostic}" not in result.stdout
                or "1 failed" not in result.stdout
            ):
                raise RuntimeError(f"{name}: exact selected refusal was not demonstrated")
            print(f"PASS {name}: {node}: {diagnostic}")


if __name__ == "__main__":
    main()
