#!/usr/bin/env python3
"""Prove each expected-red guard catches a weakening while its control stays green."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECKER = "dev/check_first_slice_expected_red.py"
TESTS = "tests/test_first_slice_expected_red.py"
CONTROL = "test_current_registry_is_the_reviewed_expected_red_boundary"
COPIED_FILES = (
    CHECKER,
    "dev/mutate_first_slice_expected_red.py",
    TESTS,
    "dev/__init__.py",
    "tests/first_slice/scenarios.toml",
)
MUTATIONS = (
    (
        "required-count-guard",
        'if data.get("required_count") != EXPECTED_COUNT:',
        "if False:",
        "test_wrong_required_count_is_refused",
        "required_count must be 33",
    ),
    (
        "state-count-guard",
        "if actual_states != EXPECTED_STATES or unknown_states:",
        "if False:",
        "test_a_passing_scenario_is_refused",
        "state counts must be",
    ),
    (
        "decision-boundary-guard",
        "if decision_statuses != EXPECTED_DECISIONS:",
        "if False:",
        "test_a_decision_boundary_change_is_refused",
        "decision statuses differ",
    ),
    (
        "blocked-scenario-guard",
        "if blocked != EXPECTED_BLOCKED:",
        "if False:",
        "test_a_blocker_reassigned_to_another_open_decision_is_refused",
        "blocked scenarios differ",
    ),
)


def main() -> None:
    outcomes = []
    environment = {
        key: os.environ[key]
        for key in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL")
        if key in os.environ
    }
    with tempfile.TemporaryDirectory(prefix="first-slice-expected-red-") as temporary:
        for name, old, new, target, expected in MUTATIONS:
            root = Path(temporary) / name
            (root / "dev").mkdir(parents=True)
            (root / "tests/first_slice").mkdir(parents=True)
            for relative in COPIED_FILES:
                destination = root / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / relative, destination)
            source = (root / CHECKER).read_text(encoding="utf-8")
            if source.count(old) != 1:
                raise RuntimeError(f"mutation anchor is not unique: {name}")
            (root / CHECKER).write_text(source.replace(old, new), encoding="utf-8")
            (root / "pytest.ini").write_text("[pytest]\n", encoding="utf-8")
            result = subprocess.run(  # noqa: S603 - fixed local test process
                [
                    sys.executable,
                    "-m",
                    "pytest",
                    "-c",
                    "pytest.ini",
                    "-p",
                    "no:django",
                    "--junitxml=result.xml",
                    f"{TESTS}::{target}",
                    f"{TESTS}::{CONTROL}",
                ],
                cwd=root,
                env=environment,
                capture_output=True,
                text=True,
                timeout=30,
            )
            suite = ET.parse(root / "result.xml")  # noqa: S314 - local pytest output
            cases = {case.attrib["name"]: case for case in suite.findall(".//testcase")}
            failure = cases[target].find("failure")
            control = cases[CONTROL]
            caught = (
                result.returncode == 1
                and failure is not None
                and expected in failure.attrib.get("message", "")
            )
            control_passed = all(
                control.find(kind) is None for kind in ("failure", "error", "skipped")
            )
            outcomes.append(
                {
                    "mutation": name,
                    "caught": caught,
                    "control_passed": control_passed,
                }
            )
    print(json.dumps(outcomes, indent=2))
    if not all(row["caught"] and row["control_passed"] for row in outcomes):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
