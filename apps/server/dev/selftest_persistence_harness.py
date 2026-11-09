#!/usr/bin/env python3
"""Exercise owned-resource refusal weakenings through fake Docker only."""

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CASES = (
    (
        "reserve",
        "if shutil.disk_usage(ROOT).free < 5 * 1024**3:",
        "if False:",
        "test_harness_requires_reserve_before_start",
        "Regex pattern did not match",
    ),
    (
        "ownership",
        'if details["Config"].get("Labels", {}).get(LABEL) != owner:',
        "if False:",
        "test_harness_refuses_wrong_label_before_removal",
        "DID NOT RAISE",
    ),
)


def main() -> None:
    original = (ROOT / "dev/accept_persistence.py").read_text()
    for name, old, new, node, assertion in CASES:
        if old not in original:
            raise RuntimeError(f"{name}: mutation target missing")
        with tempfile.TemporaryDirectory(prefix="customer-harness-mutation-") as temporary:
            target = Path(temporary)
            (target / "dev").mkdir()
            (target / "tests").mkdir()
            for name_in_repo in (
                "dev/accept_persistence.py",
                "dev/accept_runtime.py",
                "tests/test_customer_persistence_harness.py",
            ):
                shutil.copyfile(ROOT / name_in_repo, target / name_in_repo)
            environment = {
                "PATH": os.defpath,
                "PYTHONPATH": str(ROOT),
                "DJANGO_SETTINGS_MODULE": "config.settings.dev",
                "PYTHONDONTWRITEBYTECODE": "1",
            }
            for phase in ("baseline", "mutant"):
                if phase == "mutant":
                    (target / "dev/accept_persistence.py").write_text(original.replace(old, new, 1))
                result = subprocess.run(  # noqa: S603
                    [
                        sys.executable,
                        "-m",
                        "pytest",
                        "-q",
                        str(target / "tests/test_customer_persistence_harness.py") + "::" + node,
                    ],
                    cwd=target,
                    env=environment,
                    capture_output=True,
                    text=True,
                    timeout=20,
                    check=False,
                )
                if phase == "baseline":
                    if result.returncode != 0 or "1 passed" not in result.stdout:
                        raise RuntimeError(f"{name}: exact fake-Docker baseline failed")
                else:
                    failures = [
                        line for line in result.stdout.splitlines() if line.startswith("FAILED ")
                    ]
                    if (
                        result.returncode != 1
                        or len(failures) != 1
                        or not failures[0].split(" - ")[0].endswith("::" + node)
                        or assertion not in result.stdout
                        or "1 failed" not in result.stdout
                    ):
                        raise RuntimeError(f"{name}: exact resource refusal assertion not observed")
            print(f"PASS fake-Docker mutation {name}: {node}")


if __name__ == "__main__":
    main()
