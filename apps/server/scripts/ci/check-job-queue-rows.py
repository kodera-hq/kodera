#!/usr/bin/env python3
"""Check, from outside tests/job_queue/, that every job-queue acceptance row ran.

The conftest in tests/job_queue/ fails a run that enters the directory and leaves a row without a
call report, and tests/test_job_queue_inventory.py fails a tracked configuration that would keep
the directory out. Neither sees a run that never enters the directory because of the command line
or the environment: `--ignore=tests/job_queue`, a `-k` or `--deselect`, or the same in
PYTEST_ADDOPTS exits 0 with no acceptance row run (docs/specs/JOB_QUEUE.md §9.1, §9.2).

This check reads the JUnit XML report pytest wrote and the inventory, and requires each inventory
row to appear exactly once, under the acceptance module, with the outcome its state promises:
`xfail` rows reported as expected failures, `pass` rows reported with no failure, error or skip.
A skip is not a call report: a row skipped at setup never ran its assertions.

An xfail row proves nothing on its own, so the proofs that each row fails a broken queue are
required too, passed, from the self-test module: for every row, its run against the permissive and
the inert queue and the deletion of its named assertion; and, once, the mutant-row check.

The real queue is proven too (§9.2): for every mutants.toml row, the runner that runs its flag
against the real queue, passed; the check that the committed flags are exactly the rows; the check
that JOB_QUEUE_EXTRA_BINDINGS is unset; for every settings module but test.py — a module file
under config/settings/, a package there, and each module inside a package — the check that it
cannot enable a flag, with that check's mutations, one per refusal, and the proof that its walk
finds a package and the modules inside it; and the static check that no module under config/ but
test.py names the settings that permit or set flags, with its mutation.
Direct control refusals, profile-spoof fixtures and their guard weakenings are required too.
Isolation caller omissions, actual/default substitution, caching, ordering and read-failure proofs
from tests/test_job_queue_isolation.py are required independently of the shared predicate row.
JOB_QUEUE_EXTRA_BINDINGS set in this check's own environment fails it: no binding outside the
repository may stand in for the queue.

Usage: check-job-queue-rows.py --junit PATH [--root DIR]
Exit status: 0 when every row ran as its state says, 1 otherwise.
"""

from __future__ import annotations

import argparse
import os
import sys
import tomllib
import xml.etree.ElementTree as ET
from pathlib import Path

INVENTORY = Path("tests/job_queue/acceptance.toml")
MUTANTS = Path("tests/job_queue/mutants.toml")
SETTINGS = Path("config/settings")
MODULE = "tests.job_queue.test_job_queue_acceptance"
SELFTEST = "tests.job_queue.test_job_queue_selftest"
BROKEN_QUEUE = "test_every_acceptance_test_fails_a_broken_queue_with_its_exact_message"
DELETION = "test_deleting_the_named_assertion_changes_how_the_permissive_queue_fails"
MUTANT_ROWS = "test_every_mutant_row_names_an_owning_test_and_its_own_exact_message"
RUNNER = "test_every_mutant_flag_is_caught_by_its_owning_test_on_the_real_queue"
REGISTERED = "test_every_mutant_row_has_a_registered_flag_and_nothing_else_is_registered"
NO_EXTRA_BINDINGS = "test_no_binding_outside_the_repository_stands_in_for_the_queue"
REFUSED = "tests.test_job_queue_flags_refused"
NO_SETTINGS_MODULE = "test_no_settings_module_but_test_can_enable_a_mutant_flag"
REFUSAL_PROOFS = (
    "test_the_refusal_check_fails_a_settings_module_that_reads_its_flags_from_input",
    "test_the_refusal_check_fails_a_settings_module_that_enables_flags_by_itself",
    "test_the_refusal_check_fails_a_settings_module_that_does_not_start",
    "test_no_module_under_config_but_test_names_the_mutant_settings",
    "test_the_static_check_fails_a_module_that_names_the_mutant_settings",
    "test_the_settings_walk_finds_a_settings_package_and_the_modules_inside_it",
)
CONTROLS = "tests.test_job_queue_mutant_controls"
CONTROL_PROOFS = (
    "test_custom_profiles_cannot_enable_queue_controls",
    "test_direct_settings_assignment_cannot_spoof_the_test_profile",
    "test_test_profile_permission_requires_true_and_matching_identity",
    "test_actual_test_profile_allows_overrides_and_revokes_permission",
    "test_control_proof_rejects_each_permission_weakening",
    "test_runtime_controls_refuse_invalid_flags_and_concurrent_activation",
    "test_database_controls_refuse_foreign_snapshots_and_unknown_mutants",
    "test_pristine_guard_comparison_reports_missing_and_disarmed_guards",
)
ISOLATION = "tests.test_job_queue_isolation"
ISOLATION_PROOFS = (
    "test_each_transaction_omission_is_caught",
    "test_default_setting_substitution_is_caught",
    "test_cached_preflight_substitution_is_caught",
    "test_isolation_rewrite_substitution_is_caught",
    "test_validation_and_cleanup_reordering_are_caught",
    "test_failed_isolation_read_never_assumes_read_committed",
)
XFAIL = "pytest.xfail"
QUEUES = ("permissive", "inert")


def outcome(case: ET.Element) -> str:
    """The outcome a JUnit test case records: pass, xfail, skip, failure or error.

    A failure or an error wins over a skip: an expected failure whose teardown then errs carries
    both, the skip first."""
    tags = [child.tag for child in case]
    for tag in ("error", "failure"):
        if tag in tags:
            return tag
    for child in case:
        if child.tag == "skipped":
            return "xfail" if child.get("type") == XFAIL else "skip"
    return "pass"


def settings_modules(settings: Path) -> list[str]:
    """Every settings module under `settings` but config.settings.test, by dotted name: a module
    file, a package (its __init__.py) and each module inside a package, at any depth. A symbolic
    link to a directory is not followed. tests/test_job_queue_flags_refused.py walks the same way:
    a module this walk finds and that one misses has no report, which fails here. A module only
    that walk finds is checked there and not required here."""
    names = set()
    for path in settings.rglob("*.py"):
        parts = path.relative_to(settings).with_suffix("").parts
        if parts[-1] == "__init__":
            parts = parts[:-1]
        if parts and parts != ("test",):
            names.add(".".join(("config", "settings", *parts)))
    return sorted(names)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--junit", required=True, type=Path)
    parser.add_argument("--root", default=".", type=Path)
    args = parser.parse_args()

    if "JOB_QUEUE_EXTRA_BINDINGS" in os.environ:
        print("FAILED: JOB_QUEUE_EXTRA_BINDINGS is set in the job that checks the rows")
        return 1
    try:
        rows = tomllib.loads((args.root / INVENTORY).read_text(encoding="utf-8"))["test"]
    except (OSError, tomllib.TOMLDecodeError, KeyError) as error:
        print(f"FAILED: cannot read the inventory {INVENTORY}: {error}")
        return 1
    try:
        flags = [
            row["flag"]
            for row in tomllib.loads((args.root / MUTANTS).read_text(encoding="utf-8"))["mutant"]
        ]
    except (OSError, tomllib.TOMLDecodeError, KeyError, TypeError) as error:
        print(f"FAILED: cannot read the mutant rows {MUTANTS}: {error}")
        return 1
    if not flags:
        print(f"FAILED: {MUTANTS} lists no mutant row")
        return 1
    modules = settings_modules(args.root / SETTINGS)
    if not modules:
        print(f"FAILED: {SETTINGS} holds no settings module but test.py to check")
        return 1
    if not rows:
        print(f"FAILED: the inventory {INVENTORY} lists no row")
        return 1
    try:
        # The report is the one this job's own pytest step just wrote, not outside input.
        report = ET.parse(args.junit).getroot()  # noqa: S314
    except (OSError, ET.ParseError) as error:
        print(f"FAILED: cannot read the JUnit report {args.junit}: {error}")
        return 1

    cases: dict[tuple[str, str], list[str]] = {}
    for case in report.iter("testcase"):
        key = (case.get("classname", ""), case.get("name", ""))
        cases.setdefault(key, []).append(outcome(case))

    problems = []
    for row in rows:
        found = cases.get((MODULE, row["function"]), [])
        if len(found) != 1:
            problems.append(f"{row['id']} ({row['function']}) has {len(found)} reports, not 1")
        elif found[0] != row["state"]:
            problems.append(f"{row['id']} reported {found[0]}, but its state is {row['state']}")
    ran = len(rows) - len(problems)

    proofs = [f"{BROKEN_QUEUE}[{row['id']}-{queue}]" for row in rows for queue in QUEUES]
    proofs += [f"{DELETION}[{row['id']}]" for row in rows] + [MUTANT_ROWS]
    proofs += [f"{RUNNER}[{flag}]" for flag in flags] + [REGISTERED, NO_EXTRA_BINDINGS]
    required = [(SELFTEST, name) for name in proofs]
    required += [(REFUSED, f"{NO_SETTINGS_MODULE}[{module}]") for module in modules]
    required += [(REFUSED, name) for name in REFUSAL_PROOFS]
    required += [(CONTROLS, name) for name in CONTROL_PROOFS]
    required += [(ISOLATION, name) for name in ISOLATION_PROOFS]
    for classname, name in required:
        found = cases.get((classname, name), [])
        if found != ["pass"]:
            test = "self-test" if classname == SELFTEST else "check"
            problems.append(f"the {test} {name} reported {found or 'nothing'}, not one pass")

    print(f"{ran} of {len(rows)} job-queue acceptance rows produced a call report")
    print(f"{len(required)} self-test proofs required for them")
    for problem in problems:
        print(f"FAILED: {problem}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
