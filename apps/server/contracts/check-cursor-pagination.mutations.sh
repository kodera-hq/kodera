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
original = (source / "check_cursor_pagination.py").read_text()
mutations = [
    (
        "inventory",
        "if name != expected or not is_page:",
        "if name != expected:",
        "population removal",
        "expected 1/PAG-INVENTORY, got exit 0",
    ),
    (
        "response alias",
        'node, _ = self.resolve(value, "responses")',
        "node = mapping(value)",
        "equivalent response alias",
        "expected 0/27 operations validated, got exit 1",
    ),
    (
        "error response",
        'if f"#/components/responses/{component}" not in refs or not proper_body:',
        "if False:",
        "extension cannot declare error",
        "expected 1/PAG-RESPONSE, got exit 0",
    ),
    (
        "parameter schema",
        "return json.dumps(actual, sort_keys=True) == json.dumps(schema, sort_keys=True)",
        "return True",
        "boolean limit",
        "expected 1/PAG-PARAMETER, got exit 0",
    ),
    (
        "operation override",
        'effective.update(reader.parameters(operation.get("parameters", [])))',
        'for key, value in reader.parameters(operation.get("parameters", [])).items():\n                effective.setdefault(key, value)',
        "effective override",
        "expected 1/PAG-PARAMETER, got exit 0",
    ),
    (
        "input capacity",
        "MAX_BYTES = 2 * 1024 * 1024",
        "MAX_BYTES = 128 * 1024",
        "actual inventory",
        "expected 0/27 operations validated, got exit 2",
    ),
    (
        "page definition",
        "if not canonical_page:",
        "if False:",
        "page definition removal",
        "expected 1/PAG-RESPONSE, got exit 0",
    ),
    (
        "schema annotation compatibility",
        "actual.pop(annotation, None)",
        "pass",
        "equivalent Cursor schema description",
        "expected 0/27 operations validated, got exit 1",
    ),
    (
        "numeric spelling compatibility",
        "actual[key] = expected",
        "pass",
        "equivalent numeric limit bounds",
        "expected 0/27 operations validated, got exit 1",
    ),
    (
        "boolean numeric coercion",
        "not isinstance(value, bool)",
        "True",
        "boolean minimum cannot equal one",
        "expected 1/PAG-PARAMETER, got exit 0",
    ),
    (
        "nullable type order compatibility",
        'in (["string", "null"], ["null", "string"])',
        '== ["string", "null"]',
        "equivalent nullable type order",
        "expected 0/27 operations validated, got exit 1",
    ),
]
with tempfile.TemporaryDirectory(prefix="pagination-mutations-") as directory:
    target = Path(directory)
    for name in (
        "check-cursor-pagination.sh",
        "check-cursor-pagination.acceptance.sh",
        "core-api.openapi.yaml",
    ):
        shutil.copyfile(source / name, target / name)
    for name, before, after, probe, expected in mutations:
        if original.count(before) != 1:
            raise SystemExit(f"FAIL {name}: mutation location must be unique")
        (target / "check_cursor_pagination.py").write_text(original.replace(before, after))
        result = subprocess.run(  # noqa: S603 - private helper and fixed synthetic arguments
            [
                bash,
                str(target / "check-cursor-pagination.acceptance.sh"),
                str(target / "core-api.openapi.yaml"),
                "--probe",
                probe,
            ],
            capture_output=True,
            text=True,
            env=dict(os.environ),
            timeout=30,
        )
        output = result.stdout + result.stderr
        assertion = f"FAIL {probe}: {expected}"
        if result.returncode != 1 or assertion not in output or "Traceback" in output:
            raise SystemExit(f"FAIL {name}: weakening did not fail its specific assertion")
        print(f"PASS {name}: weakening caught by {probe}", flush=True)
print(f"pagination weakening proof: {len(mutations)} specific assertions caught regressions")
PY
