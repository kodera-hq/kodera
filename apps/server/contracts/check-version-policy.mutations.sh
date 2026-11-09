#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
python_command="${PYTHON:-python3}"
"$python_command" - "$script_dir" <<'PY'
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

source = Path(sys.argv[1])
bash = shutil.which("bash")
if bash is None:
    raise SystemExit("FAIL: bash is required")
checker = (source / "check-version-policy.sh").read_text()
mutations = [
    (
        "input capacity",
        "MAX_BYTES = 2 * 1024 * 1024",
        "MAX_BYTES = 128 * 1024",
        "FAIL repository core-api.openapi.yaml: expected 0/PASS:, got 2: INPUT:",
    ),
    (
        "mapping equality",
        "sort_keys=True",
        "sort_keys=False",
        "FAIL mapping order: expected 0/PASS:, got 1: POLICY:",
    ),
]
failures = []
with tempfile.TemporaryDirectory(prefix="version-policy-mutations-") as directory:
    target = Path(directory)
    for name in (
        "check-version-policy.selftest.sh",
        "core-api.openapi.yaml",
        "agent-api.openapi.yaml",
    ):
        shutil.copyfile(source / name, target / name)
    for name, original, replacement, diagnostic in mutations:
        if checker.count(original) != 1:
            raise SystemExit(f"FAIL {name}: mutation location must be unique")
        (target / "check-version-policy.sh").write_text(checker.replace(original, replacement))
        result = subprocess.run(  # noqa: S603
            [bash, str(target / "check-version-policy.selftest.sh")],
            env=dict(os.environ, PYTHON=sys.executable),
            capture_output=True,
            text=True,
            timeout=60,
        )
        output = result.stdout + result.stderr
        if result.returncode != 1 or diagnostic not in output or "Traceback" in output:
            failures.append(name)
            print(f"FAIL {name}: self-test missed the specific positive regression")
        else:
            print(f"PASS {name}: specific positive assertion caught weakening")
if failures:
    raise SystemExit(1)
print("version policy weakening mutations passed: 2 specific positive regressions caught")
PY
