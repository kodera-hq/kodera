#!/usr/bin/env python3
"""Prove each fault-point guard catches its weakening, by its own message, in a disposable copy.

Each mutant is a plausible way the fault-point harness stops meaning what it says: a timed-out
hold counted as served, a reach() deleted or aliased, the after-commit site moved before the
commit, a crash an `except Exception` can swallow, the test-profile gate dropped, a point no
scenario arms, a scenario that no longer arms its point, and a scenario arming a name nobody
recorded. Each must turn its owning check red with that check's
message while a control that the mutant does not touch stays green, which proves the copy was
mutated surgically rather than broken. A mutant whose anchor no longer matches exactly once is a
failure of this file, reported by name. Nothing here touches the working tree, and no case needs a
database: the owning checks read source, or start child interpreters on a settings module.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

STATIC = "tests/test_first_slice_fault_points.py::test_the_tree_matches_the_fault_point_inventory"
GATE = (
    "tests/test_job_queue_flags_refused.py::"
    "test_no_settings_module_but_test_can_arm_a_fault_point[config.settings.deploy]"
)


@dataclass(frozen=True)
class Mutant:
    name: str
    # (file, old, new): each `old` must occur exactly once in its file.
    edits: tuple[tuple[str, str, str], ...]
    owner: str
    message: str
    control: str


AFTER_COMMIT_SITE = """                # Committed, and nothing answered yet: a worker's claim is the dispatch
                # (ADR-0004), so this is also `intake:after-commit-before-dispatch`.
                faults.reach("intake:after-commit")
"""

HOLD = "tests/test_first_slice_fault_points.py::test_a_hold_that_times_out_fails_the_scenario"
HOLD_TIMEOUT = """            if hold is not None:
                # A hold crashes only when nobody released it: the race it served never ran.
                raise AssertionError(f"hold {name} timed out") from crash
"""

MUTANTS = (
    *(
        Mutant(
            f"deleted-{site}",
            ((path, f'{indent}faults.reach("worker:{site}")\n', ""),),
            STATIC,
            f"site worker:{site} has 0 faults.reach() calls in Core; it must have exactly one",
            GATE,
        )
        for site, path, indent in (
            ("inside-completed-ack-before-step", "apps/jobs/_runner.py", "                "),
            ("after-completed-ack", "apps/jobs/_runner.py", "        "),
            ("after-completion-claim-projection", "worker/runner.py", "        "),
        )
    ),
    Mutant(
        "timed-out-hold-swallowed",
        (("tests/first_slice/first_slice_harness.py", HOLD_TIMEOUT, ""),),
        HOLD,
        "a timed-out hold was swallowed",
        GATE,
    ),
    Mutant(
        "deleted-reach",
        (("apps/orgs/intake_services.py", '    faults.reach("intake:after-job")\n', ""),),
        STATIC,
        "site intake:after-job has 0 faults.reach() calls in Core; it must have exactly one",
        GATE,
    ),
    Mutant(
        "aliased-reach",
        (
            (
                "apps/orgs/intake_services.py",
                '    faults.reach("intake:after-job")\n',
                '    hit = faults.reach\n    hit("intake:after-job")\n',
            ),
        ),
        STATIC,
        "refers to faults.reach other than by calling it",
        GATE,
    ),
    Mutant(
        "deleted-worker-reach",
        (
            (
                "worker/runner.py",
                '            faults.reach("worker:after-failed-dispatch-close-before-step-record")\n',
                "",
            ),
        ),
        STATIC,
        "site worker:after-failed-dispatch-close-before-step-record has 0 faults.reach() calls in Core; it must have exactly one",
        GATE,
    ),
    Mutant(
        "dropped-worker-arm",
        (
            (
                "tests/worker/test_failed_dispatch_recovery.py",
                '            control.arm("worker:after-recovered-failed-step", "kill")\n',
                "            pass\n",
            ),
        ),
        STATIC,
        "fault point worker:after-recovered-failed-step: the inventory records it armed by tests/worker/test_failed_dispatch_recovery.py::test_failed_dispatch_survives_worker_deaths, and the scenarios arm it in none",
        GATE,
    ),
    Mutant(
        "after-commit-moved-before-the-commit",
        (
            ("apps/orgs/api/intake.py", AFTER_COMMIT_SITE, ""),
            (
                "apps/orgs/api/intake.py",
                "                response = respond_once(\n",
                '                faults.reach("intake:after-commit")\n'
                "                response = respond_once(\n",
            ),
        ),
        STATIC,
        "site intake:after-commit is reached in organisations before respond_once returns there",
        GATE,
    ),
    Mutant(
        "crash-caught-as-exception",
        (
            (
                "core/faults.py",
                "class SimulatedCrash(BaseException):",
                "class SimulatedCrash(Exception):",
            ),
        ),
        STATIC,
        "SimulatedCrash derives from Exception, not from BaseException alone",
        GATE,
    ),
    Mutant(
        "gate-dropped",
        (
            (
                "core/faults.py",
                '    if (\n        os.environ.get("DJANGO_SETTINGS_MODULE") != TEST_SETTINGS\n',
                '    if False and (\n        os.environ.get("DJANGO_SETTINGS_MODULE") != TEST_SETTINGS\n',
            ),
        ),
        GATE,
        "config.settings.deploy arms intake:after-desired-state",
        STATIC,
    ),
    Mutant(
        "orphan-point",
        (
            (
                "core/faults.py",
                '        "intake:after-job": Point("intake:after-job", "crash"),\n',
                '        "intake:after-job": Point("intake:after-job", "crash"),\n'
                '        "intake:orphan": Point("intake:after-job", "crash"),\n',
            ),
            (
                "tests/first_slice/fault_points.toml",
                "# -------------------------------------------------------------------------- planned ----\n",
                '[[point]]\nname = "intake:orphan"\nsite = "intake:after-job"\nmode = "crash"\n'
                "scenarios = []\n\n"
                "# -------------------------------------------------------------------------- planned ----\n",
            ),
        ),
        STATIC,
        "fault point intake:orphan lists no scenario that arms it",
        GATE,
    ),
    Mutant(
        "dropped-scenario-use",
        (
            (
                "tests/first_slice/test_fs_operations.py",
                '    with h.fault_point("intake:hold-before-commit"):\n',
                "    if True:\n",
            ),
        ),
        STATIC,
        "fault point intake:hold-before-commit: the inventory records it armed by FS-OP-01, and "
        "the scenarios arm it in none",
        GATE,
    ),
    Mutant(
        "unrecorded-scenario-name",
        (
            (
                "tests/first_slice/test_fs_concurrency.py",
                '    for boundary in ("after-desired-state", "after-audit", "after-job"):\n',
                '    for boundary in ("after-desired-state", "after-audit", "after-jobs"):\n',
            ),
        ),
        STATIC,
        "FS-CON-06 arms intake:after-jobs, which the fault-point inventory does not record",
        GATE,
    ),
)


def tracked_files() -> list[str]:
    """The files of the tree, as git sees them: tracked, and new files not ignored."""
    listed = subprocess.run(  # noqa: S603 - fixed git invocation
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],  # noqa: S607
        cwd=ROOT,
        capture_output=True,
        check=True,
    ).stdout.decode()
    return [name for name in listed.split("\0") if name and (ROOT / name).is_file()]


def run(root: Path, owner: str, control: str) -> tuple[int, dict[str, ET.Element]]:
    report = root / "result.xml"
    report.unlink(missing_ok=True)
    environment = {
        key: os.environ[key]
        for key in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "DJANGO_SECRET_KEY")
        if key in os.environ
    }
    result = subprocess.run(  # noqa: S603 - fixed tests and interpreter, no caller commands
        [
            sys.executable,
            "-m",
            "pytest",
            "-p",
            "no:randomly",
            "-p",
            "no:cacheprovider",
            "-o",
            "junit_family=xunit1",
            f"--junitxml={report}",
            owner,
            control,
        ],
        cwd=root,
        env={**environment, "PYTHONPATH": str(root), "PYTHONDONTWRITEBYTECODE": "1"},
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    if not report.exists():
        return result.returncode, {}
    suite = ET.parse(report)  # noqa: S314 - XML this exact local pytest process wrote
    cases = {}
    for case in suite.findall(".//testcase"):
        cases[f"{case.attrib.get('file', '')}::{case.attrib['name']}"] = case
        cases[case.attrib["name"]] = case
    return result.returncode, cases


def case_of(cases: dict[str, ET.Element], node_id: str) -> ET.Element | None:
    return cases.get(node_id.split("::", 1)[1])


def failure_text(case: ET.Element | None) -> str:
    if case is None:
        return ""
    failure = case.find("failure")
    if failure is None:
        return ""
    return f"{failure.attrib.get('message', '')}\n{failure.text or ''}"


def passed(case: ET.Element | None) -> bool:
    return case is not None and all(
        case.find(kind) is None for kind in ("failure", "error", "skipped")
    )


def main() -> None:
    outcomes = []
    with tempfile.TemporaryDirectory(prefix="fault-point-mutations-") as temporary:
        root = Path(temporary) / "tree"
        for relative in tracked_files():
            destination = root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, destination)
        # The unmutated copy first: both checks every mutant uses must pass on it, or no red below
        # could be told from a broken copy.
        status, cases = run(root, STATIC, GATE)
        baseline = status == 0 and passed(case_of(cases, STATIC)) and passed(case_of(cases, GATE))
        outcomes.append({"mutation": "none (baseline)", "caught": None, "control_passed": baseline})
        for mutant in MUTANTS:
            originals = {
                path: (root / path).read_text(encoding="utf-8") for path, _, _ in mutant.edits
            }
            sources = dict(originals)
            stale = [old for path, old, _ in mutant.edits if sources[path].count(old) != 1]
            if stale:
                outcomes.append(
                    {
                        "mutation": mutant.name,
                        "caught": False,
                        "control_passed": False,
                        "refusal": f"mutation-anchor-not-applied:{mutant.name}: re-anchor it on "
                        "the current source rather than deleting it",
                    }
                )
                continue
            for path, old, new in mutant.edits:
                sources[path] = sources[path].replace(old, new)
            try:
                for path, source in sources.items():
                    (root / path).write_text(source, encoding="utf-8")
                status, cases = run(root, mutant.owner, mutant.control)
            finally:
                for path, source in originals.items():
                    (root / path).write_text(source, encoding="utf-8")
            owner = case_of(cases, mutant.owner)
            caught = status == 1 and mutant.message in failure_text(owner)
            outcomes.append(
                {
                    "mutation": mutant.name,
                    "owner": mutant.owner,
                    "caught": caught,
                    "control_passed": passed(case_of(cases, mutant.control)),
                }
            )
    print(json.dumps(outcomes, indent=2))
    if not baseline or not all(row["caught"] and row["control_passed"] for row in outcomes[1:]):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
