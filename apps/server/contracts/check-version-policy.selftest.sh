#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
python_command="${PYTHON:-python3}"
"$python_command" - "$script_dir/check-version-policy.sh" <<'PY'
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

checker = sys.argv[1]
bash = shutil.which("bash")
if bash is None:
    raise SystemExit("FAIL: bash is required")
passed = 0
rejected = 0


def document(version):
    return {"openapi": "3.1.0", "info": {"title": "Synthetic API", "version": version}, "paths": {}}


with tempfile.TemporaryDirectory(prefix="contract-version-test-") as directory:
    base = Path(directory) / "base.yaml"
    candidate = Path(directory) / "candidate.yaml"

    def run(
        name,
        old,
        new,
        kind,
        expected=0,
        category="PASS:",
        labels=(),
        mutate=None,
        raw=None,
        extra=(),
        base_mutate=None,
    ):
        global passed, rejected
        before = document(old)
        if base_mutate:
            base_mutate(before)
        base.write_text(json.dumps(before), encoding="utf-8")
        after = document(new)
        if mutate:
            mutate(after)
        candidate.write_text(raw if raw is not None else json.dumps(after), encoding="utf-8")
        args = [bash, checker, "--base", str(base), "--candidate", str(candidate)]
        if kind is not None:
            args += ["--change", kind]
        for label in labels:
            args += ["--label", label]
        # Fixed local checker and synthetic arguments, without shell interpretation.
        result = subprocess.run(  # noqa: S603
            args + list(extra),
            text=True,
            capture_output=True,
            env=dict(os.environ, PYTHON=sys.executable),
            timeout=10,
        )
        output = result.stdout + result.stderr
        if "SYNTHETIC_PRIVATE_MARKER" in output or "Traceback" in output:
            raise SystemExit(f"FAIL {name}: source content or traceback leaked")
        if result.returncode != expected or category not in output:
            raise SystemExit(
                f"FAIL {name}: expected {expected}/{category}, got {result.returncode}: {output}"
            )
        if expected:
            rejected += 1
        else:
            if "human approval unchecked" not in output:
                raise SystemExit(f"FAIL {name}: missing scope reminder")
            passed += 1

    for name, old, new, kind in [
        ("unchanged", "0.4.1", "0.4.1", "unchanged"),
        ("patch", "0.4.1", "0.4.2", "patch"),
        ("numeric ordering", "0.4.9", "0.4.10", "patch"),
        ("additive", "0.4.1", "0.5.0", "additive"),
        ("additive major", "1.4.1", "2.0.0", "additive"),
        ("prelaunch breaking", "0.4.1", "0.5.0", "breaking"),
        ("freeze promotion", "0.4.1", "1.0.0", "breaking"),
        ("frozen breaking", "1.4.1", "2.0.0", "breaking"),
    ]:
        run(name, old, new, kind, labels=("contract:breaking",))
    run("formatting", "0.4.1", "0.4.1", "unchanged", raw=json.dumps(document("0.4.1"), indent=4))
    run(
        "mapping order",
        "0.4.1",
        "0.4.1",
        "unchanged",
        raw=json.dumps(dict(reversed(list(document("0.4.1").items())))),
    )
    run(
        "YAML comment",
        "0.4.1",
        "0.4.1",
        "unchanged",
        raw="# Synthetic formatting-only comment\n" + json.dumps(document("0.4.1")),
    )
    run(
        "changed patch",
        "0.4.1",
        "0.4.2",
        "patch",
        mutate=lambda d: d["info"].update(description="Synthetic prose"),
    )
    for name, old, new, kind, labels in [
        ("no bump", "0.4.1", "0.4.1", "patch", ()),
        ("regression", "0.4.1", "0.3.9", "patch", ()),
        ("major regression", "1.4.1", "0.9.0", "breaking", ("contract:breaking",)),
        ("additive patch", "0.4.1", "0.4.2", "additive", ()),
        ("prelaunch breaking patch", "0.4.1", "0.4.2", "breaking", ("contract:breaking",)),
        ("frozen breaking minor", "1.4.1", "1.5.0", "breaking", ("contract:breaking",)),
        ("missing label", "0.4.1", "0.5.0", "breaking", ()),
        ("near label", "0.4.1", "0.5.0", "breaking", ("contract:breaking-extra",)),
        ("unchanged bump", "0.4.1", "0.4.2", "unchanged", ()),
    ]:
        run(name, old, new, kind, 1, "POLICY:", labels)
    run(
        "unchanged payload",
        "0.4.1",
        "0.4.1",
        "unchanged",
        1,
        "POLICY:",
        mutate=lambda d: d["info"].update(description="Changed"),
    )
    for version in [
        "01.2.3",
        "1.02.3",
        "1.2.03",
        "1.2",
        "v1.2.3",
        "1.2.3-beta",
        "1.2.3+build",
        "1.2.3\n",
        1,
        None,
    ]:
        run("malformed candidate version", "0.4.1", version, "patch", 2, "INPUT:")
    run("malformed base version", "bad", "0.5.0", "patch", 2, "INPUT:")
    run(
        "boolean is not integer",
        "0.4.1",
        "0.4.1",
        "unchanged",
        1,
        "POLICY:",
        base_mutate=lambda d: d.update({"x-value": True}),
        mutate=lambda d: d.update({"x-value": 1}),
    )
    prefix = "openapi: 3.1.0\ninfo: {title: Synthetic API, version: 0.5.0}\npaths: {}\n"
    for name, suffix in [
        ("timestamp", "x-value: 2020-01-01"),
        ("set", "x-value: !!set {one: null}"),
        ("binary", "x-value: !!binary YQ=="),
        ("non-finite", "x-value: .nan"),
        ("cycle", "x-value: &loop [*loop]"),
        ("alias", "x-value: &value [one]\nx-copy: *value"),
        ("non-string key", "x-value: {1: value}"),
        ("custom tag", "x-value: !!python/object:builtins.str {}"),
        ("redaction", "x-value: [SYNTHETIC_PRIVATE_MARKER"),
        ("input limit", "#" + "x" * (2 * 1024 * 1024)),
    ]:
        run(name, "0.4.1", "0.5.0", "patch", 2, "INPUT:", raw=prefix + suffix)
    for raw in [
        "[",
        "[]",
        "null",
        "{}",
        "openapi: 3.1.0\ninfo: []\npaths: {}",
        "openapi: 3.1.0\ninfo: {title: Synthetic API, version: 0.5.0, version: 0.6.0}\npaths: {}",
    ]:
        run("malformed document", "0.4.1", "0.5.0", "patch", 2, "INPUT:", raw=raw)
    for field, value in [("openapi", "2.0"), ("paths", []), ("openapi", None)]:
        run(
            "invalid shape",
            "0.4.1",
            "0.5.0",
            "patch",
            2,
            "INPUT:",
            mutate=lambda d, f=field, v=value: d.update({f: v}),
        )
    run(
        "different API",
        "0.4.1",
        "0.5.0",
        "patch",
        2,
        "INPUT:",
        mutate=lambda d: d["info"].update(title="Other API"),
    )
    run(
        "empty title",
        "0.4.1",
        "0.5.0",
        "patch",
        2,
        "INPUT:",
        mutate=lambda d: d["info"].update(title=""),
    )
    run("no classification", "0.4.1", "0.5.0", None, 2, "usage:")
    run("unknown classification", "0.4.1", "0.5.0", "auto", 2, "usage:")
    run(
        "missing file",
        "0.4.1",
        "0.5.0",
        "patch",
        2,
        "INPUT:",
        extra=("--base", str(Path(directory) / "missing.yaml")),
    )

    for filename in ("core-api.openapi.yaml", "agent-api.openapi.yaml"):
        contract = Path(checker).parent / filename
        # Read actual committed-sized documents through the same checker. A
        # synthetic replacement would miss an accidentally reduced input cap.
        result = subprocess.run(  # noqa: S603
            [
                bash,
                checker,
                "--base",
                str(contract),
                "--candidate",
                str(contract),
                "--change",
                "unchanged",
            ],
            text=True,
            capture_output=True,
            env=dict(os.environ, PYTHON=sys.executable),
            timeout=10,
        )
        output = result.stdout + result.stderr
        if result.returncode != 0 or "PASS:" not in output:
            raise SystemExit(
                f"FAIL repository {filename}: expected 0/PASS:, got {result.returncode}: {output}"
            )
        if "human approval unchecked" not in output:
            raise SystemExit(f"FAIL repository {filename}: missing scope reminder")
        passed += 1

print(f"version policy self-test passed: {passed} positive cases and {rejected} rejected mutations")
PY
