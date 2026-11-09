"""Prove the first-slice harness fails, in disposable copies, by exit status and by message.

Each row copies the repository, applies one weakening, runs a child pytest on the copy and requires
the exact exit status, every sentence that names what was broken, the tests it names as refused to
have failed, and the controls in the same run to stay green. The exit status alone would accept a
child that failed for any unrelated reason; the message alone would accept a child whose refusal
no longer reaches the one bit CI consumes.

The children run concurrently and without a test database: what they prove is the harness's own
binding, selection and refusal logic, which never reaches the database, and a child that did reach
it would fail on pytest-django's access guard rather than pass.
"""

import os
import shutil
import subprocess
import sys
import uuid
import xml.etree.ElementTree as ET
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from first_slice_harness import child_environment, disposable_copy

SELFTEST = "tests/first_slice/test_first_slice_harness_selftest.py"
POPULATION = f"{SELFTEST}::test_collected_scenarios_equal_the_inventory_and_the_manifest"
WELL_FORMED = f"{SELFTEST}::test_the_inventory_is_well_formed_and_states_every_scenario_honestly"
TRIPWIRE = f"{SELFTEST}::test_catalogue_publication_is_measured_against_the_contract_and_the_models"
BOOT = "tests/first_slice/test_fs_bootstrap.py"
IDS = "tests/first_slice/test_fs_lifetimes_identifiers.py"
OPS = "tests/first_slice/test_fs_operations.py"
CON = "tests/first_slice/test_fs_concurrency.py"
BILL = "tests/first_slice/test_fs_billing.py"
JOURNEY = "tests/first_slice/test_fs_journey_harness.py"
SCENARIO_FILES = (BOOT, IDS, OPS, CON, BILL, JOURNEY)
INVENTORY = "tests/first_slice/scenarios.toml"
CONTRACT = "contracts/core-api.openapi.yaml"
FS_BOOT_02 = (
    f"{BOOT}::test_fs_boot_02_a_crash_at_each_bootstrap_boundary_resumes_without_manual_repair"
)
FS_BOOT_03 = f"{BOOT}::test_fs_boot_03_only_the_intended_subject_can_claim"
FS_OP_01 = f"{OPS}::test_fs_op_01_one_intention_is_one_operation_and_one_external_effect"
FS_OP_03 = f"{OPS}::test_fs_op_03_an_altered_intention_conflicts_and_a_reserialised_one_does_not"
FS_CON_03 = f"{CON}::test_fs_con_03_a_superseded_claim_fence_cannot_record_or_dispatch"
FS_HARNESS_01 = f"{JOURNEY}::test_fs_harness_01_the_runner_refuses_before_reporting_acceptance"
CON_03_BODY = "def test_fs_con_03_a_superseded_claim_fence_cannot_record_or_dispatch(harness):\n    h = harness\n"
CATALOGUE_WRITE = (
    "  /catalog/publications:\n"
    "    post:\n"
    "      operationId: publishCatalogue\n"
    "      summary: Publish a synthetic catalogue version\n"
    "      responses:\n"
    "        '204': { description: Published. }\n"
)


def replace_once(old: str, new: str) -> Callable[[str], str]:
    def apply(source: str) -> str:
        assert source.count(old) == 1, f"mutation anchor is not unique: {old!r}"
        return source.replace(old, new)

    return apply


def cut_between(start: str, end: str) -> Callable[[str], str]:
    def apply(source: str) -> str:
        assert source.count(start) == 1 and source.count(end) == 1, (
            "mutation anchors are not unique"
        )
        return source[: source.index(start)] + source[source.index(end) :]

    return apply


def database_suffix(name: str) -> str:
    """A test database name no other child run can hold.

    A name derived from the mutation alone is shared by every run of that row: a copy left by an
    interrupted run, or the same row in a parallel session against the same PostgreSQL, keeps it
    open, Django exits while recreating it, and the child reports an unrelated fixture error.
    """
    return f"mut_{name.replace('-', '_')[:24]}_{uuid.uuid4().hex[:8]}"


def line(scenario_id: str, label: str, suffix: str) -> str:
    return f"{scenario_id:<14} {label:<20} {suffix}"


@dataclass(frozen=True)
class Mutation:
    name: str
    file: str | None
    apply: Callable[[str], str] | None
    targets: tuple[str, ...]
    status: int
    messages: tuple[str, ...]
    refused: tuple[str, ...]
    controls: tuple[str, ...]
    arguments: tuple[str, ...] = ()


MUTATIONS = (
    Mutation(
        "unmutated-baseline",
        None,
        None,
        (POPULATION, *SCENARIO_FILES),
        0,
        ("32 xfail, 1 blocked (of 33 mandatory)",),
        (),
        (POPULATION, FS_HARNESS_01, FS_OP_01),
    ),
    Mutation(
        "scenario-removed",
        BOOT,
        cut_between('@scenario("FS-BOOT-03")', '@scenario("FS-BOOT-04")'),
        (POPULATION, WELL_FORMED),
        1,
        ("FS-BOOT-03 is in the inventory but no collected test carries it",),
        (POPULATION,),
        (WELL_FORMED,),
    ),
    Mutation(
        "identifier-misspelled",
        BOOT,
        replace_once('@scenario("FS-BOOT-04")', '@scenario("FS-BOOT-4")'),
        (POPULATION, WELL_FORMED),
        1,
        (
            "test_fs_boot_04_an_expired_revoked_altered_or_consumed_claim_grants_nothing carries a malformed scenario identifier",
            "FS-BOOT-04 is in the inventory but no collected test carries it",
        ),
        (POPULATION,),
        (WELL_FORMED,),
    ),
    Mutation(
        "strict-xfail-passes-trivially",
        BOOT,
        replace_once(
            "def test_fs_boot_02_a_crash_at_each_bootstrap_boundary_resumes_without_manual_repair(harness):\n    h = harness\n",
            "def test_fs_boot_02_a_crash_at_each_bootstrap_boundary_resumes_without_manual_repair(harness):\n    h = harness\n    return\n",
        ),
        (FS_BOOT_02, FS_OP_01),
        1,
        (
            "[XPASS(strict)] FS-BOOT-02 not built",
            line("FS-BOOT-02", "passed unexpectedly", "")[:36],
        ),
        (FS_BOOT_02,),
        (FS_OP_01,),
    ),
    Mutation(
        "red-for-an-unrecorded-reason",
        INVENTORY,
        replace_once(
            'gap = "harness:identity-provider-second-factor"\nreason = "the staff intake is routed, its complete and in-flight replies carry the durable realm_create job key as X-Operation-Ref',
            'gap = "operation:placeOrder"\nreason = "the staff intake is routed, its complete and in-flight replies carry the durable realm_create job key as X-Operation-Ref',
        ),
        (FS_OP_01, FS_CON_03),
        1,
        (
            "FS-OP-01 is red for a reason the inventory does not record: expected gap "
            "'operation:placeOrder', observed 'harness:identity-provider-second-factor'",
        ),
        (FS_OP_01,),
        (FS_CON_03,),
    ),
    Mutation(
        "scenario-skipped",
        CON,
        replace_once(CON_03_BODY, CON_03_BODY + '    __import__("pytest").skip("not today")\n'),
        (FS_CON_03, FS_OP_01),
        1,
        ("FS-CON-03 was skipped; a mandatory first-slice scenario may not skip",),
        (FS_CON_03,),
        (FS_OP_01,),
    ),
    Mutation(
        "imperative-xfail-instead-of-a-gap",
        CON,
        replace_once(CON_03_BODY, CON_03_BODY + '    __import__("pytest").xfail("known")\n'),
        (FS_CON_03, FS_OP_01),
        1,
        (
            "FS-CON-03 is red for a reason the inventory does not record: expected gap 'harness:identity-provider-second-factor', observed None",
        ),
        (FS_CON_03,),
        (FS_OP_01,),
    ),
    Mutation(
        "owner-gated-decision-recorded-as-decided-without-reconciliation",
        INVENTORY,
        replace_once(
            'source = "first-slice FS-D3; docs/specs/FIRST_SLICE_G1.md"\nstatus = "open"',
            'source = "first-slice FS-D3; docs/specs/FIRST_SLICE_G1.md"\nstatus = "decided"',
        ),
        (FS_OP_01,),
        4,
        (
            "FS-LIFE-03 is red on decision post-identity-erasure-one-time-redelivery, which the "
            "inventory records as decided",
        ),
        (),
        (),
    ),
    Mutation(
        "scenarios-deselected-by-marker",
        None,
        None,
        (POPULATION, WELL_FORMED, BOOT),
        1,
        (
            "first-slice population incomplete: deselected FS-BOOT-01, FS-BOOT-02, FS-BOOT-03, "
            "FS-BOOT-04, FS-BOOT-05, FS-BOOT-06, FS-BOOT-07;",
        ),
        (),
        (POPULATION, WELL_FORMED),
        ("-m", "not first_slice_scenario"),
    ),
    Mutation(
        "scenario-deselected-by-node",
        None,
        None,
        (BOOT,),
        1,
        ("first-slice population incomplete: deselected FS-BOOT-03;",),
        (),
        (FS_BOOT_02,),
        ("--deselect", FS_BOOT_03),
    ),
    Mutation(
        "catalogue-publication-appears",
        CONTRACT,
        replace_once("  /catalog/plans:\n", CATALOGUE_WRITE + "  /catalog/plans:\n"),
        (TRIPWIRE, FS_OP_03, WELL_FORMED),
        1,
        ("a catalogue publication surface exists: POST /catalog/publications (publishCatalogue)",),
        (TRIPWIRE, FS_OP_03),
        (WELL_FORMED,),
    ),
)


@dataclass(frozen=True)
class Outcome:
    status: int
    output: str
    cases: dict[str, Any]


def _cases(junit: Path) -> dict[str, Any]:
    if not junit.is_file():
        return {}
    # Written by the child pytest this module just ran, never external input.
    report = ET.parse(junit)  # noqa: S314
    return {case.attrib["name"]: case for case in report.findall(".//testcase")}


@pytest.fixture(scope="module")
def outcomes(tmp_path_factory):
    pristine = disposable_copy(tmp_path_factory.mktemp("first-slice-pristine") / "repo")
    bases = {
        mutation.name: tmp_path_factory.mktemp(f"mutation-{mutation.name}")
        for mutation in MUTATIONS
    }

    def run(mutation: Mutation) -> Outcome:
        base = bases[mutation.name]
        root = base / "repo"
        shutil.copytree(pristine, root)
        if mutation.file is not None and mutation.apply is not None:
            target = root / mutation.file
            target.write_text(mutation.apply(target.read_text(encoding="utf-8")), encoding="utf-8")
        junit = base / "result.xml"
        # A fixed interpreter running pytest on this repository's own copied tests; no caller input.
        result = subprocess.run(  # noqa: S603
            [
                sys.executable,
                "-m",
                "pytest",
                "-p",
                "no:cacheprovider",
                f"--junitxml={junit}",
                *mutation.arguments,
                *mutation.targets,
            ],
            cwd=root,
            # Its own test database: a scenario now reaches the database before its gap (the
            # catalogue is published through the catalogue models), as it will on every path.
            env=child_environment(
                {"FIRST_SLICE_TEST_DATABASE_SUFFIX": database_suffix(mutation.name)}
            ),
            capture_output=True,
            text=True,
            timeout=900,
            check=False,
        )
        return Outcome(result.returncode, result.stdout + result.stderr, _cases(junit))

    results: dict[str, Outcome | BaseException] = {}
    with ThreadPoolExecutor(max_workers=max(1, min(len(MUTATIONS), os.cpu_count() or 2))) as pool:
        futures = {mutation.name: pool.submit(run, mutation) for mutation in MUTATIONS}
        for name, future in futures.items():
            try:
                results[name] = future.result()
            except Exception as error:  # noqa: BLE001 - an anchor that no longer matches fails its own row
                results[name] = error
    return results


@pytest.mark.parametrize("mutation", MUTATIONS, ids=[mutation.name for mutation in MUTATIONS])
def test_the_harness_refuses_each_weakening_by_status_and_message(mutation, outcomes):
    outcome = outcomes[mutation.name]
    if isinstance(outcome, BaseException):
        raise outcome
    output = outcome.output
    # Head and tail: a child that fails while setting up says why at the top, and a tail-only
    # excerpt keeps the cascade and loses the cause.
    tail = (
        output if len(output) <= 14000 else f"{output[:6000]}\n[... elided ...]\n{output[-8000:]}"
    )
    assert outcome.status == mutation.status, (
        f"{mutation.name}: the child exited {outcome.status}, expected {mutation.status}\n{tail}"
    )
    for message in mutation.messages:
        assert message in output, f"{mutation.name}: the child never said {message!r}\n{tail}"
    for refused in mutation.refused:
        name = refused.rsplit("::", 1)[1]
        assert name in outcome.cases and outcome.cases[name].find("failure") is not None, (
            f"{mutation.name}: {name} did not fail\n{tail}"
        )
    for control in mutation.controls:
        name = control.rsplit("::", 1)[1]
        assert name in outcome.cases, f"{mutation.name}: control {name} was not run\n{tail}"
        broken = [
            kind for kind in ("failure", "error") if outcome.cases[name].find(kind) is not None
        ]
        assert not broken, f"{mutation.name}: control {name} reported {broken}\n{tail}"
