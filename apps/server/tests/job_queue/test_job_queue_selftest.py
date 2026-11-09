"""Proof that the job-queue acceptance tests can fail, and fail for the reason they name.

docs/specs/JOB_QUEUE.md §9.1:

1. Every acceptance test fails both counterexample queues with the exact message its row names.
2. Deleting that assertion changes how the permissive queue fails the test.
3. `mutants.toml` names, per property, its owning tests, and per mutant a message asserted verbatim,
   where the test always runs it and it can fail, of something it reads, in one owning test alone.
   Textual and structural only.
4. Each observation the tests rest on can see both outcomes (harness controls).
5. The gap is measured and comes from the harness, and the strict binding refuses every escape, from
   real child runs: in a test body, at collection, and by selection.
"""

from __future__ import annotations

import ast
import collections
import inspect
import json
import os
import re
import subprocess
import sys
import tomllib
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

import database_mutants
import pytest
import test_job_queue_acceptance as acceptance
from queue_harness import (
    HERE,
    MARKER,
    MUTANTS_PATH,
    PROBE_TABLE,
    ROOT,
    SPEC_PATH,
    ActorError,
    BarrierError,
    QueueGapError,
    RealBinding,
    binding_class,
    gap_is_missing,
    open_queue_env,
)
from queue_inventory import (
    HARNESS_PATH,
    INVENTORY,
    InventoryError,
    assertion_messages,
    load_inventory,
    mutant_refusals,
    pass_verdict,
    verdict,
)

# An application no tree ever installs. The binding proofs bind every row to its gap, so they keep
# proving the strict binding once apps.jobs exists and after the last row moves to `pass`.
ABSENT_APP = "apps.job_queue_selftest_absent"
ABSENT_GAP = f"app:{ABSENT_APP}"


@pytest.fixture
def absent_gap(monkeypatch: pytest.MonkeyPatch) -> str:
    """ABSENT_GAP, placed in the harness's closed list of gaps for this test."""
    monkeypatch.setattr(RealBinding, "APPS", (ABSENT_APP, *RealBinding.APPS))
    return ABSENT_GAP


def _identifier(function: object) -> str | None:
    marks = [mark for mark in getattr(function, "pytestmark", []) if mark.name == MARKER]
    return marks[0].args[0] if len(marks) == 1 else None


def _first_line(error: BaseException) -> str:
    return str(error).split("\n", 1)[0]


# ------------------------------------------------------------------------------ inventory ----


def test_the_inventory_and_the_acceptance_tests_are_one_list() -> None:
    functions = {
        name: function
        for name, function in inspect.getmembers(acceptance, inspect.isfunction)
        if name.startswith("test_")
    }
    unmarked = sorted(name for name, function in functions.items() if _identifier(function) is None)
    assert not unmarked, f"acceptance tests with no identifier: {unmarked}"
    collected = {str(_identifier(function)): name for name, function in functions.items()}
    assert len(collected) == len(functions), "two acceptance tests share an identifier"
    assert set(collected) == set(INVENTORY), (
        f"only in the tests: {sorted(set(collected) - set(INVENTORY))}; "
        f"only in the inventory: {sorted(set(INVENTORY) - set(collected))}"
    )
    for identifier, name in collected.items():
        assert INVENTORY[identifier]["function"] == name, f"{identifier} names the wrong function"


@pytest.mark.parametrize(
    ("text", "refusal"),
    [
        ("format = 2", "format must be 1"),
        ('format = 1\n[[test]]\nid = "A3-1"', "malformed identifier"),
        (
            'format = 1\n[[test]]\nid = "A3-01"\nstate = "xfail"\nfunction = "test_a3_x"\n'
            'permissive = "p"\ninert = "i"',
            "no well-formed gap",
        ),
        (
            'format = 1\n[[test]]\nid = "A3-01"\nstate = "pass"\ngap = "app:apps.jobs"\n'
            'function = "test_a3_x"\npermissive = "p"\ninert = "i"',
            "passes and still records gap",
        ),
        (
            'format = 1\n[[test]]\nid = "A3-01"\nstate = "xfail"\ngap = "app:apps.jobs"\n'
            'function = "test_a3_x"\npermissive = "p"',
            "names no assertion the inert queue must fail",
        ),
        ("format = 1", "the inventory has no test"),
    ],
)
def test_a_malformed_inventory_is_refused_by_name(text: str, refusal: str) -> None:
    with pytest.raises(InventoryError, match=refusal):
        load_inventory(text)


class _ForgedError(QueueGapError):
    pass


def _relabelled() -> QueueGapError:
    """A gap raised while an assertion failure was being handled, as `raise … from None` leaves it."""
    try:
        try:
            raise AssertionError("a real failure")
        except AssertionError:
            raise QueueGapError(ABSENT_GAP, "relabelled") from None
    except QueueGapError as error:
        return error


@pytest.mark.parametrize(
    ("when", "outcome", "wasxfail", "error", "refusal"),
    [
        ("call", "skipped", "reason", QueueGapError(ABSENT_GAP, "absent"), None),
        ("setup", "passed", None, None, None),
        (
            "call",
            "skipped",
            "reason",
            QueueGapError("service:apps.jobs.services.x", "absent"),
            "red at gap service:apps.jobs.services.x",
        ),
        (
            "call",
            "skipped",
            "reason",
            _ForgedError(ABSENT_GAP, "forged"),
            "not exactly QueueGapError",
        ),
        ("call", "skipped", "reason", AssertionError("real"), "expected failure on AssertionError"),
        ("call", "skipped", "reason", None, "expected failure on no exception"),
        ("call", "skipped", "[NOTRUN] reason", None, "[NOTRUN]"),
        ("call", "skipped", None, None, "skipped, which no inventory state allows"),
        ("call", "passed", "reason", None, "passed while the inventory records gap"),
        ("setup", "skipped", None, None, "skipped in setup"),
        ("setup", "failed", None, QueueGapError(ABSENT_GAP, "absent"), "failed in setup"),
        ("setup", "skipped", "reason", QueueGapError(ABSENT_GAP, "absent"), "failed in setup"),
        (
            "call",
            "skipped",
            "reason",
            _relabelled(),
            "A3-01 raised its gap while handling AssertionError: a failure relabelled as a gap",
        ),
    ],
)
def test_only_exactly_the_recorded_gap_in_the_call_is_an_expected_failure(
    absent_gap: str,
    when: str,
    outcome: str,
    wasxfail: str | None,
    error: BaseException | None,
    refusal: str | None,
) -> None:
    row = {"id": "A3-01", "gap": ABSENT_GAP}
    found = verdict(
        row,
        when=when,
        outcome=outcome,
        wasxfail=wasxfail,
        error=error,
        origin=str(HARNESS_PATH),
    )
    if refusal is None:
        assert found is None
    else:
        assert found is not None and refusal in found


@pytest.mark.parametrize(
    ("gap", "origin", "refusal"),
    [
        (ABSENT_GAP, str(HARNESS_PATH), None),
        (
            ABSENT_GAP,
            __file__,
            "A3-01 raised its gap from test_job_queue_selftest.py, not from the harness's gap probe",
        ),
        (ABSENT_GAP, None, "A3-01 raised its gap from nowhere"),
        (
            "module:apps.jobs.never_to_be_written",
            str(HARNESS_PATH),
            "A3-01 is bound to gap module:apps.jobs.never_to_be_written, which the harness never "
            "raises",
        ),
    ],
)
def test_a_gap_is_accepted_only_from_the_harness_and_from_its_closed_list(
    absent_gap: str, gap: str, origin: str | None, refusal: str | None
) -> None:
    row = {"id": "A3-01", "gap": gap}
    error = QueueGapError(gap, "absent")
    found = verdict(
        row, when="call", outcome="skipped", wasxfail="reason", error=error, origin=origin
    )
    if refusal is None:
        assert found is None
    else:
        assert found is not None and refusal in found


def test_every_inventory_gap_is_one_the_harness_can_raise() -> None:
    gaps = RealBinding.gaps()
    assert {row["gap"] for row in INVENTORY.values() if row["state"] == "xfail"} <= gaps
    assert "service:apps.jobs.services.claim_job" in gaps
    assert "module:apps.jobs.never_to_be_written" not in gaps


def test_a_gap_this_tree_now_provides_is_not_an_expected_failure(absent_gap: str) -> None:
    row = {"id": "A3-01", "gap": absent_gap}
    error = QueueGapError(absent_gap, "absent")

    def judged(measure: object = None) -> str | None:
        if measure is None:
            return verdict(
                row,
                when="call",
                outcome="skipped",
                wasxfail="reason",
                error=error,
                origin=str(HARNESS_PATH),
            )
        return verdict(
            row,
            when="call",
            outcome="skipped",
            wasxfail="reason",
            error=error,
            origin=str(HARNESS_PATH),
            measure=lambda gap: measure == "missing",
        )

    assert judged("missing") is None
    refusal = judged("provided")
    assert refusal is not None and "which this tree provides when measured again" in refusal
    assert judged() is None, "a synthetic absent application measured as present"


def test_a_gap_is_measured_as_provided_for_each_kind(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`gap_is_missing` itself, not an injected measure: present and absent, for all three kinds."""
    name = f"job_queue_selftest_{uuid.uuid4().hex}"
    (tmp_path / f"{name}.py").write_text("def enqueue_job(**_):\n    return None\n", "utf-8")
    monkeypatch.syspath_prepend(str(tmp_path))
    assert gap_is_missing("app:apps.orgs") is False, "an installed application measured missing"
    assert gap_is_missing("app:apps.not_a_job_queue") is True
    assert gap_is_missing(f"module:{name}") is False, "a module that exists measured missing"
    assert gap_is_missing("module:job_queue_selftest_absent.services") is True
    assert gap_is_missing(f"service:{name}.enqueue_job") is False, (
        "a function that exists measured missing"
    )
    assert gap_is_missing(f"service:{name}.claim_job") is True
    assert gap_is_missing("service:job_queue_selftest_absent.services.claim_job") is True


@pytest.mark.parametrize(
    ("when", "outcome", "wasxfail", "refusal"),
    [
        ("call", "passed", None, None),
        ("call", "failed", None, None),
        ("call", "skipped", None, "A3-01 is a pass row and was skipped in call"),
        ("call", "skipped", "reason", "A3-01 is a pass row and was an expected failure in call"),
        ("setup", "skipped", None, "A3-01 is a pass row and was skipped in setup"),
        ("teardown", "skipped", "reason", "was an expected failure in teardown"),
    ],
)
def test_a_pass_row_is_never_skipped_or_excused(
    when: str, outcome: str, wasxfail: str | None, refusal: str | None
) -> None:
    found = pass_verdict({"id": "A3-01"}, when=when, outcome=outcome, wasxfail=wasxfail)
    if refusal is None:
        assert found is None
    else:
        assert found is not None and refusal in found


def _child_pytest(
    arguments: list[str], environment: dict[str, str]
) -> subprocess.CompletedProcess[str]:
    """A child run whose `CI` and `PYTEST_ADDOPTS` are the caller's alone, never inherited: the
    call-report rule reads `CI`, and each branch of it is proven on purpose."""
    inherited = {k: v for k, v in os.environ.items() if k not in {"CI", "PYTEST_ADDOPTS"}}
    return subprocess.run(  # noqa: S603 - a fixed interpreter and arguments
        [sys.executable, "-m", "pytest", "-p", "no:randomly", "-p", "no:cacheprovider", *arguments],
        cwd=ROOT,
        env={**inherited, **environment},
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )


def _copy_directory(destination: Path, *, selftest: bool = False) -> Path:
    """A disposable copy of this directory, with or without this self-test."""
    copy = destination / "job_queue"
    copy.mkdir(parents=True)
    for source in HERE.iterdir():
        if source.suffix in {".py", ".toml"} and (selftest or source.name != Path(__file__).name):
            (copy / source.name).write_bytes(source.read_bytes())
    return copy


def _toml_string(value: str) -> str:
    """A TOML basic string: JSON's escapes are a subset of TOML's."""
    return json.dumps(value, ensure_ascii=False)


def _xfail_copy(destination: Path, *, selftest: bool = False) -> Path:
    """A disposable copy in which every row is a strict xfail on a gap no tree ever provides: the
    harness raises ABSENT_GAP before any gap of the queue, whatever this tree already provides."""
    copy = _copy_directory(destination, selftest=selftest)
    harness = (copy / "queue_harness.py").read_text(encoding="utf-8")
    original = 'APPS = ("apps.jobs", "apps.outbox", "apps.audit")'
    assert harness.count(original) == 1, "the harness's application list moved"
    harness = harness.replace(
        original, f'APPS = ("{ABSENT_APP}", "apps.jobs", "apps.outbox", "apps.audit")'
    )
    (copy / "queue_harness.py").write_text(harness, encoding="utf-8")
    data = tomllib.loads((copy / "acceptance.toml").read_text(encoding="utf-8"))
    lines = [f"format = {data['format']}"]
    for row in data["test"]:
        lines.append("\n[[test]]")
        for key, value in row.items():
            if key == "gap":
                continue
            if key == "state":
                lines.append('state = "xfail"')
                lines.append(f"gap = {_toml_string(ABSENT_GAP)}")
            else:
                lines.append(f"{key} = {_toml_string(value)}")
    (copy / "acceptance.toml").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return copy


def _child_environment() -> dict[str, str]:
    return {
        "JOB_QUEUE_TEST_DATABASE_SUFFIX": f"binding_{uuid.uuid4().hex[:8]}",
        "JOB_QUEUE_REPOSITORY_ROOT": str(ROOT),
    }


def _rooted(*arguments: str) -> list[str]:
    return ["-rA", "--rootdir", str(ROOT), "-c", str(ROOT / "pyproject.toml"), *arguments]


ALL_ROWS = ", ".join(sorted(INVENTORY))


def test_every_acceptance_test_is_collected_as_a_strict_expected_failure_on_a_gap(
    tmp_path: Path,
) -> None:
    report = tmp_path / "collection.json"
    completed = _child_pytest(
        ["--collect-only", "-q", str(HERE / "test_job_queue_acceptance.py")],
        {"JOB_QUEUE_COLLECTION_REPORT": str(report)},
    )
    assert completed.returncode == 0, completed.stdout[-2000:] + completed.stderr[-2000:]
    collected = {entry["id"]: entry for entry in json.loads(report.read_text(encoding="utf-8"))}
    assert set(collected) == set(INVENTORY), "the collection does not match the inventory"
    for identifier, row in INVENTORY.items():
        bindings = collected[identifier]["xfail"]
        if row["state"] == "xfail":
            assert bindings == [{"strict": True, "raises": "QueueGapError"}], (
                f"{identifier} is not bound as exactly one strict expected failure on "
                f"QueueGapError: {bindings}"
            )
        else:
            assert bindings == [], f"{identifier} passes and still carries an expected failure"

    # A copy bound to a gap no tree provides: the strict binding itself, whatever state rows are in.
    copy = _xfail_copy(tmp_path / "copy")
    copied = tmp_path / "copied.json"
    completed = _child_pytest(
        _rooted("--collect-only", "-q", str(copy / "test_job_queue_acceptance.py")),
        {"JOB_QUEUE_COLLECTION_REPORT": str(copied)},
    )
    assert completed.returncode == 0, completed.stdout[-2000:] + completed.stderr[-2000:]
    collected = {entry["id"]: entry for entry in json.loads(copied.read_text(encoding="utf-8"))}
    assert set(collected) == set(INVENTORY), "the copy's collection does not match the inventory"
    for identifier, entry in collected.items():
        assert entry["xfail"] == [{"strict": True, "raises": "QueueGapError"}], (
            f"{identifier} in the copy is not bound as exactly one strict expected failure on "
            f"QueueGapError: {entry['xfail']}"
        )


# One weakening per acceptance test, each an escape the binding must refuse by its own sentence.
ESCAPES = {
    "test_a3_02_": ("body", "    return\n", "[XPASS(strict)]"),
    "test_a3_03_": (
        "body",
        "    raise AssertionError('a real failure, not a gap')\n",
        "a real failure, not a gap",
    ),
    "test_a3_04_": (
        "body",
        "    import pytest\n\n    pytest.skip('weakened')\n",
        "A3-04 skipped, which no inventory state allows",
    ),
    "test_a3_05_": ("body", "    raise RuntimeError('not a gap either')\n", "not a gap either"),
    "test_a3_06_": (
        "body",
        "    import pytest\n\n    pytest.xfail('excused')\n",
        "A3-06 was an expected failure on XFailed, not exactly QueueGapError",
    ),
    "test_a3_07_": (
        "marker",
        "@pytest.mark.xfail(strict=False, reason='excused')\n",
        "A3-07 carries its own xfail marker, which the inventory owns",
    ),
    "test_a3_08_": (
        "marker",
        "@pytest.mark.skipif(True, reason='excused')\n",
        "A3-08 carries its own skipif marker, which the inventory owns",
    ),
    "test_a3_09_": (
        "body",
        f"    class Forged(QueueGapError):\n        pass\n\n    raise Forged({ABSENT_GAP!r}, 'forged')\n",
        "A3-09 was an expected failure on Forged, not exactly QueueGapError",
    ),
    "test_a3_10_": (
        "fixture",
        "moved_gap",
        "A3-10 failed in setup: only the test body may reach the gap",
    ),
    "test_a3_13_": (
        "marker",
        "@pytest.mark.xfail(run=False, reason='excused')\n",
        "A3-13 carries its own xfail marker, which the inventory owns",
    ),
    # A gap forged for the real binding only: the counterexample runs never see it.
    "test_a3_14_": (
        "body",
        "    if queue_env.binding_name == 'real':\n"
        f"        raise QueueGapError({ABSENT_GAP!r}, 'forged for the real binding')\n",
        "A3-14 raised its gap from test_job_queue_acceptance.py, not from the harness's gap probe",
    ),
    "test_a3_15_": (
        "body",
        "    try:\n        raise AssertionError('a real failure')\n    except AssertionError:\n"
        f"        raise QueueGapError({ABSENT_GAP!r}, 'relabelled') from None\n",
        "A3-15 raised its gap while handling AssertionError: a failure relabelled as a gap",
    ),
    "test_a3_16_": (
        "body",
        "    raise QueueGapError('module:apps.jobs.never_to_be_written', 'never exists')\n",
        "A3-16 is bound to gap module:apps.jobs.never_to_be_written, which the harness never "
        "raises",
    ),
}
NEVER_EXISTING_ROW = ("A3-16", 'gap = "module:apps.jobs.never_to_be_written"')
MOVED_GAP_ROW = "A3-11"
DESELECTED_ROW = "test_a3_12_"
# Rows turned into `pass` rows in the copy, each with an escape a pass row may not take.
PASS_ESCAPES = {
    "A3-21": (
        "test_a3_21_",
        "    import pytest\n\n    pytest.skip('a pass row skipped')\n",
        "A3-21 is a pass row and was skipped in call",
    ),
    "A3-22": (
        "test_a3_22_",
        "    import pytest\n\n    pytest.xfail('a pass row excused')\n",
        "A3-22 is a pass row and was an expected failure in call",
    ),
}


def _bounded_outcome_diagnostic(text: str) -> str:
    marker = "\n... [diagnostic truncated] ...\n"
    if len(text) > 8192:
        left = (8192 - len(marker)) // 2
        right = 8192 - len(marker) - left
        return text[:left] + marker + text[-right:]
    return text


def _outcome_failure(prefix: str, found: list[str], lines: list[str]) -> str:
    """Bound the complete assertion message, including summaries and original sections."""
    title = "Original job-queue teardown failure"
    match = re.fullmatch(r"test_a3_(\d{2})_", prefix)
    row_name = f"A3-{match[1]}" if match is not None else None
    diagnostic = ""
    section: str | None = None

    def keep_section() -> None:
        nonlocal diagnostic
        if section is not None and row_name is not None and section.startswith(f"[{row_name}]\n"):
            diagnostic = _bounded_outcome_diagnostic(diagnostic + "\n" + section)

    for line in lines:
        if re.fullmatch(r"-+ " + re.escape(title) + r" -+", line.strip()):
            keep_section()
            section = ""
        elif re.fullmatch(r"[-_=]{3,}.*[-_=]{3,}", line.strip()):
            keep_section()
            section = None
        elif section is not None:
            section = _bounded_outcome_diagnostic(section + line + "\n")
    keep_section()
    return _bounded_outcome_diagnostic(
        f"{prefix} has {len(found)} summary lines: {found}" + diagnostic
    )


def test_the_binding_refuses_every_escape_in_a_real_run(tmp_path: Path) -> None:
    """A child run over a disposable copy of this directory, with one weakening per test: each must
    fail the run by its own sentence, and every untouched test must still be an expected failure."""
    copy = _xfail_copy(tmp_path)
    inventory = (copy / "acceptance.toml").read_text(encoding="utf-8")
    bound = f'gap = "{ABSENT_GAP}"'
    moved = 'gap = "service:apps.jobs.services.enqueue_job"'
    for identifier, rebound in ((MOVED_GAP_ROW, moved), NEVER_EXISTING_ROW):
        start = inventory.index(f'id = "{identifier}"')
        gap = inventory.index(bound, start)
        inventory = inventory[:gap] + rebound + inventory[gap + len(bound) :]
    for identifier in PASS_ESCAPES:
        start = inventory.index(f'id = "{identifier}"')
        binding = f'state = "xfail"\n{bound}'
        at = inventory.index(binding, start)
        inventory = inventory[:at] + 'state = "pass"' + inventory[at + len(binding) :]
    (copy / "acceptance.toml").write_text(inventory, encoding="utf-8")

    tests = (copy / "test_job_queue_acceptance.py").read_text(encoding="utf-8")
    tests = tests.replace(
        "from queue_harness import (",
        "import pytest\nfrom queue_harness import (\n    QueueGapError,",
        1,
    )
    escapes = {
        **ESCAPES,
        **{prefix: ("body", text, s) for prefix, text, s in PASS_ESCAPES.values()},
    }
    for prefix, (kind, text, _) in escapes.items():
        head = tests.index(f"def {prefix}")
        if kind == "body":
            first = tests.index("    env = queue_env\n", head)
            tests = tests[:first] + text + tests[first:]
        elif kind == "marker":
            decorator = tests.rindex("@job_queue_acceptance", 0, head)
            tests = tests[:decorator] + text + tests[decorator:]
        else:
            signature = tests.index("queue_env: QueueEnv", head)
            tests = tests[:signature] + f"{text}: None, " + tests[signature:]
    tests += (
        "\n\n@pytest.fixture\ndef moved_gap() -> None:\n"
        "    raise QueueGapError('service:apps.jobs.services.claim_job', 'raised by a fixture')\n"
    )
    (copy / "test_job_queue_acceptance.py").write_text(tests, encoding="utf-8")
    deselected = next(
        name
        for name, _ in inspect.getmembers(acceptance, inspect.isfunction)
        if name.startswith(DESELECTED_ROW)
    )

    # `CI` is set: under it a narrowed run that leaves a row uncalled fails, whatever narrowed it.
    completed = _child_pytest(
        _rooted("-k", f"not {deselected}", str(copy / "test_job_queue_acceptance.py")),
        {**_child_environment(), "CI": "true"},
    )
    output = completed.stdout + completed.stderr
    assert completed.returncode == 1, output[-3000:]
    lines = output.splitlines()
    verdicts = {"PASSED", "FAILED", "ERROR", "XFAIL", "XPASS", "SKIPPED"}

    def outcome(prefix: str) -> str:
        found = [line for line in lines if f"::{prefix}" in line and line.split(" ")[0] in verdicts]
        assert len(found) == 1, _outcome_failure(prefix, found, lines)
        return found[0].split(" ")[0]

    for prefix, (_, _, sentence) in escapes.items():
        assert outcome(prefix) in {"FAILED", "ERROR"}, f"{prefix} was not refused"
        assert sentence in output, f"{prefix} was refused without the sentence {sentence!r}"
    moved_prefix = "test_a3_11_"
    assert outcome(moved_prefix) == "FAILED"
    assert (
        f"red at gap {ABSENT_GAP}, not the recorded service:apps.jobs.services.enqueue_job"
        in output
    )
    assert (
        "FAILED: a run that visited tests/job_queue produced no call report for job-queue "
        "acceptance rows: A3-12 (deselected: A3-12). A run may not deselect, ignore or trim a row: "
        "run the directory `tests/job_queue`."
    ) in lines, "the deselected row was not refused by the exact sentence, with its remedy: " + str(
        [line for line in lines if "call report" in line]
    )
    untouched = {row["function"][: len("test_a3_00_")] for row in INVENTORY.values()} - {
        *escapes,
        moved_prefix,
        DESELECTED_ROW,
    }
    for prefix in sorted(untouched):
        assert outcome(prefix) == "XFAIL", f"{prefix} is not an expected failure"


# Whole-module escapes: each leaves the acceptance module with no test at all, which a rule that
# reads collected items cannot see.
MODULE_ESCAPES = {
    "skip": (
        "pytest.skip('whole module excused', allow_module_level=True)\n",
        "was skipped at collection (Skipped: whole module excused)",
    ),
    "importorskip": (
        "pytest.importorskip('a_module_that_does_not_exist')\n",
        "was skipped at collection (Skipped: could not import 'a_module_that_does_not_exist'",
    ),
    "error": (
        "raise RuntimeError('the module does not import')\n",
        "was failed at collection (",
    ),
}


@pytest.mark.parametrize("escape", sorted(MODULE_ESCAPES))
@pytest.mark.parametrize("module", ["test_job_queue_acceptance.py", "test_job_queue_selftest.py"])
def test_a_module_that_yields_no_test_fails_a_run_shaped_like_ci(
    tmp_path: Path, module: str, escape: str
) -> None:
    """A parent directory holding the copy and one unrelated passing test, as CI's repository-root
    run holds this directory: without the collection rule it exits 0 with every row silenced."""
    copy = _xfail_copy(tmp_path, selftest=True)
    text, sentence = MODULE_ESCAPES[escape]
    source = (copy / module).read_text(encoding="utf-8")
    anchor = "import pytest\n" if "import pytest\n" in source else "import datetime as dt\n"
    assert source.count(anchor) == 1
    (copy / module).write_text(
        source.replace(anchor, anchor + "import pytest\n\n" + text, 1), encoding="utf-8"
    )
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "test_else.py").write_text("def test_unrelated():\n    pass\n", encoding="utf-8")

    completed = _child_pytest(_rooted(str(tmp_path)), _child_environment())
    output = completed.stdout + completed.stderr
    assert completed.returncode != 0, output[-3000:]
    refused = [line for line in output.splitlines() if "was not collected whole" in line]
    assert any(f"{module} {sentence}" in line for line in refused), output[-3000:]
    assert all(
        line.endswith("run the directory `tests/job_queue` once it collects.") for line in refused
    )


def test_a_narrowed_run_outside_ci_gets_a_notice_and_does_not_fail(tmp_path: Path) -> None:
    copy = _xfail_copy(tmp_path)
    completed = _child_pytest(
        _rooted("-k", "not test_a3_12_", str(copy / "test_job_queue_acceptance.py")),
        _child_environment(),
    )
    output = completed.stdout + completed.stderr
    assert completed.returncode == 0, output[-3000:]
    assert (
        "NOTICE: this narrowed run produced no call report for job-queue acceptance rows: A3-12 "
        "(deselected: A3-12). That fails under CI and in an unnarrowed run; to see them, run the "
        "directory `tests/job_queue`."
    ) in output.splitlines()
    assert "FAILED:" not in output


def test_an_interrupted_run_keeps_its_exit_status_and_still_names_the_uncalled_rows(
    tmp_path: Path,
) -> None:
    """The uncalled-row rule turns only a passing run into a failure: an interrupted run exits as
    interrupted, not as an ordinary test failure, and still names the rows it never called. `CI` is
    set, so the rule is strict for this file-path run."""
    copy = _xfail_copy(tmp_path)
    tests = (copy / "test_job_queue_acceptance.py").read_text(encoding="utf-8")
    head = tests.index("def test_a3_02_")
    first = tests.index("    env = queue_env\n", head)
    tests = tests[:first] + "    raise KeyboardInterrupt\n" + tests[first:]
    (copy / "test_job_queue_acceptance.py").write_text(tests, encoding="utf-8")
    completed = _child_pytest(
        _rooted(str(copy / "test_job_queue_acceptance.py")),
        {**_child_environment(), "CI": "true"},
    )
    output = completed.stdout + completed.stderr
    assert completed.returncode == pytest.ExitCode.INTERRUPTED, output[-3000:]
    # A3-01 ran and was an expected failure; A3-02 was interrupted in its call; the rest never ran.
    uncalled = ", ".join(sorted(set(INVENTORY) - {"A3-01"}))
    assert (
        "FAILED: a run that visited tests/job_queue produced no call report for job-queue "
        f"acceptance rows: {uncalled}. A run may not deselect, ignore or trim a row: run "
        "the directory `tests/job_queue`."
    ) in output.splitlines(), output[-3000:]


def test_an_unnarrowed_run_with_uncalled_rows_fails_and_a_stray_test_is_refused(
    tmp_path: Path,
) -> None:
    """No `-k`, no `CI`: ignoring the acceptance module is not a selection the rule excuses. Beside
    it, a marked test in a file of its own and a test in a sub-directory are bound to nothing."""
    copy = _xfail_copy(tmp_path)
    (copy / "test_stray.py").write_text(
        "from queue_harness import job_queue_acceptance\n\n\n"
        "@job_queue_acceptance('A3-01')\ndef test_a3_01_stray():\n    pass\n",
        encoding="utf-8",
    )
    (copy / "deeper").mkdir()
    (copy / "deeper" / "test_nested.py").write_text("def test_nested():\n    pass\n", "utf-8")
    completed = _child_pytest(
        _rooted("--ignore", str(copy / "test_job_queue_acceptance.py"), str(copy)),
        _child_environment(),
    )
    output = completed.stdout + completed.stderr
    assert completed.returncode == 1, output[-3000:]
    assert (
        "FAILED: a run that visited tests/job_queue produced no call report for job-queue "
        f"acceptance rows: {ALL_ROWS}. A run may not deselect, ignore or trim a row: run the "
        "directory `tests/job_queue`."
    ) in output.splitlines()
    for stray in ("test_stray.py::test_a3_01_stray", "deeper/test_nested.py::test_nested"):
        assert (
            f"{stray} is a test under tests/job_queue that is neither an inventory row of the "
            "acceptance module nor the self-test: it is bound to nothing"
        ) in output, f"{stray} was not refused by its own sentence"


def test_collect_only_never_fails_whatever_it_selects(tmp_path: Path) -> None:
    copy = _xfail_copy(tmp_path)
    completed = _child_pytest(
        _rooted("--collect-only", "-q", "-k", "not test_a3_12_", str(copy)),
        {**_child_environment(), "CI": "true"},
    )
    output = completed.stdout + completed.stderr
    assert completed.returncode == 0, output[-3000:]
    assert "FAILED:" not in output and "NOTICE:" not in output


def test_runxfail_is_refused_for_every_row(tmp_path: Path) -> None:
    copy = _xfail_copy(tmp_path)
    completed = _child_pytest(
        _rooted(str(copy / "test_job_queue_acceptance.py")),
        {**_child_environment(), "PYTEST_ADDOPTS": "--runxfail"},
    )
    output = completed.stdout + completed.stderr
    assert completed.returncode == 1, output[-3000:]
    for identifier in INVENTORY:
        assert f"{identifier} cannot run under --runxfail, which ignores its binding" in output


def test_a_run_without_the_skipping_plugin_is_refused_by_a_sentence(tmp_path: Path) -> None:
    copy = _xfail_copy(tmp_path)
    completed = _child_pytest(
        _rooted("-p", "no:skipping", str(copy / "test_job_queue_acceptance.py")),
        _child_environment(),
    )
    output = completed.stdout + completed.stderr
    assert completed.returncode == 1, output[-3000:]
    assert "INTERNALERROR" not in output, output[-3000:]
    for identifier in INVENTORY:
        assert f"{identifier} cannot run with pytest's skipping plugin disabled" in output


# ---------------------------------------------------------------------------- measured gap ----


def test_the_gap_names_an_application_that_is_not_installed() -> None:
    binding = RealBinding(apps=("apps.orgs", "apps.not_a_job_queue"))
    with pytest.raises(QueueGapError) as caught:
        binding.require("enqueue_job")
    assert caught.value.gap == "app:apps.not_a_job_queue"


def test_the_gap_names_a_missing_module_then_a_missing_function_then_disappears(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    missing = RealBinding(apps=("apps.orgs",), services="job_queue_selftest_absent.services")
    with pytest.raises(QueueGapError) as caught:
        missing.require("enqueue_job")
    assert caught.value.gap == "module:job_queue_selftest_absent.services"

    name = f"job_queue_selftest_{uuid.uuid4().hex}"
    (tmp_path / f"{name}.py").write_text(
        "def enqueue_job(**_):\n    return None\n", encoding="utf-8"
    )
    monkeypatch.syspath_prepend(str(tmp_path))
    present = RealBinding(apps=("apps.orgs",), services=name)
    assert callable(present.require("enqueue_job")), "a function that exists was reported missing"
    with pytest.raises(QueueGapError) as caught:
        present.require("claim_job")
    assert caught.value.gap == f"service:{name}.claim_job"


# -------------------------------------------------------------------------------- mutants ----


def _mutant_inputs() -> tuple[str, str, str]:
    return (
        MUTANTS_PATH.read_text(encoding="utf-8"),
        Path(acceptance.__file__).read_text(encoding="utf-8"),
        SPEC_PATH.read_text(encoding="utf-8"),
    )


def test_every_mutant_row_names_an_owning_test_and_its_own_exact_message() -> None:
    assert mutant_refusals(*_mutant_inputs()) == []


def test_the_mutant_check_refuses_a_missing_test() -> None:
    mutants, source, spec = _mutant_inputs()
    broken = mutants.replace('test = "A3-01"', 'test = "A3-99"', 1)
    refusals = mutant_refusals(broken, source, spec)
    assert (
        "audit_second_txn: its owning test A3-99 does not exist in the acceptance module"
        in refusals
    )


def test_the_mutant_check_refuses_a_message_that_is_only_a_piece() -> None:
    mutants, source, spec = _mutant_inputs()
    broken = mutants.replace(
        'message = "a superseded fence recorded a step"',
        'message = "a superseded fence recorded"',
        1,
    )
    refusals = mutant_refusals(broken, source, spec)
    assert (
        "step_ignores_fence: its message is not an assertion message written verbatim in A3-03"
        in refusals
    )


def test_the_mutant_check_refuses_a_message_two_tests_assert() -> None:
    mutants, source, spec = _mutant_inputs()
    broken = source + (
        '\n\n@job_queue_acceptance("A3-98")\n'
        "def test_a3_98_copy(queue_env: QueueEnv) -> None:\n"
        '    assert queue_env.schema, "a superseded fence recorded a step"\n'
    )
    refusals = mutant_refusals(mutants, broken, spec)
    assert (
        "step_ignores_fence: its message is an assertion message of 2 tests: A3-03, A3-98"
        in refusals
    )


def test_the_mutant_check_refuses_a_property_with_no_row() -> None:
    mutants, source, spec = _mutant_inputs()
    broken = spec + "\n| `JQ-P99` | A property nobody owns | §0 |\n"
    assert "property JQ-P99 of the specification has no mutant row" in mutant_refusals(
        mutants, source, broken
    )


def _mutate_assertion(source: str, message: str, change: str) -> str:
    """The acceptance source with the one `assert` carrying `message` weakened as `change` names."""
    tree = ast.parse(source)

    def parsed(text: str) -> ast.stmt:
        return ast.parse(text).body[0]

    class Change(ast.NodeTransformer):
        def visit_Assert(self, node: ast.Assert) -> ast.AST | list[ast.stmt]:
            if not (isinstance(node.msg, ast.Constant) and node.msg.value == message):
                return node
            if change == "constant":
                return ast.Assert(test=ast.Constant(value=True), msg=node.msg)
            if change in {"1 == 1", "not False", "1 == 2"}:
                return ast.Assert(test=ast.parse(change, mode="eval").body, msg=node.msg)
            if change == "fixture":
                return ast.Assert(test=ast.Name(id="queue_env", ctx=ast.Load()), msg=node.msg)
            if change == "after return":
                return [ast.Return(value=None), node]
            if change == "after raise":
                return [parsed("raise RuntimeError('left')"), node]
            if change == "after skip":
                return [parsed("pytest.skip('left')"), node]
            if change in {"suppress(AssertionError)", "pytest.raises(AssertionError)"}:
                swallowing = parsed(f"with {change}:\n    pass")
                assert isinstance(swallowing, ast.With)
                swallowing.body = [node]
                return swallowing
            if change == "try":
                swallowing = parsed("try:\n    pass\nexcept AssertionError:\n    pass")
                assert isinstance(swallowing, ast.Try)
                swallowing.body = [node]
                return swallowing
            return ast.If(test=ast.Name(id="queue_env", ctx=ast.Load()), body=[node], orelse=[])

    return ast.unparse(ast.fix_missing_locations(Change().visit(tree)))


def test_the_mutant_check_refuses_a_message_asserted_only_where_it_may_not_run() -> None:
    mutants, source, spec = _mutant_inputs()
    broken = _mutate_assertion(source, "a superseded fence recorded a step", "nested")
    assert (
        "step_ignores_fence: its message is asserted in A3-03 only where the test may not run it"
        in mutant_refusals(mutants, broken, spec)
    )


@pytest.mark.parametrize(
    "change",
    [
        "after return",
        "after raise",
        "after skip",
        "suppress(AssertionError)",
        "pytest.raises(AssertionError)",
        "try",
    ],
)
def test_the_mutant_check_refuses_an_assertion_that_never_runs_or_cannot_fail(change: str) -> None:
    mutants, source, spec = _mutant_inputs()
    broken = _mutate_assertion(source, "a superseded fence recorded a step", change)
    assert (
        "step_ignores_fence: its message is asserted in A3-03 only where the test may not run it"
        in mutant_refusals(mutants, broken, spec)
    )


@pytest.mark.parametrize("change", ["constant", "1 == 1", "not False", "1 == 2"])
def test_the_mutant_check_refuses_an_assertion_of_constants(change: str) -> None:
    mutants, source, spec = _mutant_inputs()
    broken = _mutate_assertion(source, "a superseded fence recorded a step", change)
    assert "step_ignores_fence: its assertion in A3-03 tests a constant" in mutant_refusals(
        mutants, broken, spec
    )


def test_the_mutant_check_refuses_an_assertion_of_a_bare_fixture() -> None:
    mutants, source, spec = _mutant_inputs()
    broken = _mutate_assertion(source, "a superseded fence recorded a step", "fixture")
    assert (
        "step_ignores_fence: its assertion in A3-03 tests only a fixture, which is always true"
        in mutant_refusals(mutants, broken, spec)
    )


def test_the_mutant_check_accepts_a_with_block_that_swallows_something_else() -> None:
    """Over-strict is a defect too: `suppress(ActorError)` does not swallow an assertion."""
    mutants, source, spec = _mutant_inputs()
    softened = _mutate_assertion(
        source, "a superseded fence recorded a step", "suppress(AssertionError)"
    ).replace("with suppress(AssertionError):", "with suppress(ActorError):", 1)
    assert mutant_refusals(mutants, softened, spec) == []


def test_the_mutant_check_refuses_an_owning_test_no_row_uses() -> None:
    mutants, source, spec = _mutant_inputs()
    broken = mutants.replace(
        '[property.JQ-P01]\ntests = ["A3-01"]', '[property.JQ-P01]\ntests = ["A3-01", "A3-02"]', 1
    )
    assert broken != mutants
    assert "property JQ-P01 names owning test A3-02, which no row of it uses" in mutant_refusals(
        broken, source, spec
    )


def test_the_mutant_check_refuses_two_rows_naming_one_message() -> None:
    mutants, source, spec = _mutant_inputs()
    broken = mutants.replace(
        'message = "a key reused with a different desired state was not refused"',
        'message = "a duplicate idempotency key returned a different job"',
        1,
    )
    assert "reuse_not_refused: its message is also named by no_dedupe" in mutant_refusals(
        broken, source, spec
    )


def test_the_mutant_check_refuses_a_row_moved_to_another_property() -> None:
    mutants, source, spec = _mutant_inputs()
    head = mutants.index('flag = "no_dedupe"')
    at = mutants.rindex('property = "JQ-P02"', 0, head)
    broken = mutants[:at] + 'property = "JQ-P03"' + mutants[at + len('property = "JQ-P02"') :]
    assert "no_dedupe: its test A3-02 is not an owning test of JQ-P03" in mutant_refusals(
        broken, source, spec
    )


def test_every_acceptance_test_is_read_by_the_mutant_check() -> None:
    messages = assertion_messages(Path(acceptance.__file__).read_text(encoding="utf-8"))
    assert set(messages) == set(INVENTORY)


# ------------------------------------------------------------------------ harness controls ----


def test_control_a_kill_at_a_barrier_discards_the_transaction_but_not_an_earlier_commit(
    transactional_db: None,
) -> None:
    with open_queue_env("real") as env:
        env.observer.connection.execute("CREATE TABLE IF NOT EXISTS a3_control (label text)")
        env.observer.connection.execute("TRUNCATE a3_control")
        for label, statements, committed in (
            ("one-transaction", ["BEGIN", "INSERT INTO a3_control VALUES ('one-transaction')"], 0),
            (
                "two-transactions",
                ["INSERT INTO a3_control VALUES ('two-transactions')", "BEGIN"],
                1,
            ),
        ):
            child = env.process_actor("control")
            insert = "INSERT INTO " + PROBE_TABLE + " VALUES ('" + label + "')"  # noqa: S608 - constants
            with env.barrier(PROBE_TABLE) as barrier:
                pending = child.send("execute", statements=[*statements, insert])
                barrier.wait_blocked(child.backend_pid, pending)
                held = env.observer.written_relations(child.backend_pid)
                child.kill()
                env.observer.wait_backend_gone(child.backend_pid)
            assert ("a3_control" in held) is (committed == 0), (
                f"{label}: the killed transaction's already-written relations were misread: {held}"
            )
            assert env.observer.count("a3_control", "label = %s", [label]) == committed, (
                f"{label}: a kill at the barrier was misread"
            )
            assert env.probe_count(label) == 0, f"{label}: the blocked write survived the kill"
        env.observer.connection.execute("DROP TABLE a3_control")


def test_control_a_table_a_transaction_only_read_is_not_reported_as_written(
    transactional_db: None,
) -> None:
    with open_queue_env("real") as env:
        env.observer.connection.execute("CREATE TABLE IF NOT EXISTS a3_control (label text)")
        actor = env.thread_actor("control")
        insert = "INSERT INTO " + PROBE_TABLE + " VALUES ('read-only')"  # noqa: S608 - constants
        with env.barrier(PROBE_TABLE) as barrier:
            pending = actor.send(
                "execute", statements=["BEGIN", "SELECT count(*) FROM a3_control", insert]
            )
            barrier.wait_blocked(actor.backend_pid, pending)
            written = env.observer.written_relations(actor.backend_pid)
            read = env.observer.read_relations(actor.backend_pid)
            env.observer.cancel(actor.backend_pid)
            with pytest.raises(ActorError):
                pending.result()
        actor.end_session()
        assert "a3_control" in read, f"the read the control made was not observed at all: {read}"
        assert "a3_control" not in written, (
            f"a table the transaction only read was reported as written: {written}"
        )
        env.observer.connection.execute("DROP TABLE a3_control")


def test_control_a_barrier_timeout_is_not_an_assertion_about_the_queue() -> None:
    assert not issubclass(BarrierError, AssertionError)


def test_control_a_stray_line_on_a_child_s_stdout_does_not_end_its_replies(
    transactional_db: None,
) -> None:
    with open_queue_env("real") as env:
        child = env.process_actor("control")
        child.call("noise", text="a stray line, not a reply")
        assert child.call("session") == child.backend_pid, (
            "a stray stdout line ended the reader, so the next reply was lost"
        )
        assert child.noise == ["a stray line, not a reply"]
        slow = child.send("execute", statements=["SELECT pg_sleep(2)"])
        with pytest.raises(BarrierError, match="1 line\\(s\\) to stdout that were not replies"):
            slow.result(timeout=0.1)


def test_control_a_barrier_reports_a_call_that_never_reached_it(transactional_db: None) -> None:
    with open_queue_env("real") as env:
        actor = env.thread_actor("control")
        with env.barrier(PROBE_TABLE) as barrier:
            pending = actor.send("execute", statements=["SELECT 1"])
            with pytest.raises(BarrierError, match="without reaching the barrier"):
                barrier.wait_blocked(actor.backend_pid, pending)


def test_control_a_killed_session_releases_its_advisory_locks_under_the_spec_keys(
    transactional_db: None,
) -> None:
    with open_queue_env("real") as env:
        signs: dict[bool, str] = {}
        while len(signs) < 2:
            key = str(uuid.uuid4())
            signs.setdefault(env.observer.value("SELECT hashtext(%s) < 0", [key]), key)
        negative, positive = signs[True], signs[False]
        child = env.process_actor("control")
        child.call(
            "execute",
            statements=[
                f"SELECT pg_advisory_lock_shared(1, hashtext('{negative}'))",
                f"SELECT pg_advisory_lock(2, hashtext('{positive}'))",
            ],
        )
        assert env.observer.advisory_locks(child.backend_pid) == {
            (*env.observer.advisory_key("organisation", negative), "ShareLock"),
            (*env.observer.advisory_key("tenant", positive), "ExclusiveLock"),
        }, "the observer's advisory keys do not match what the session holds"
        assert env.observer.holders("organisation", negative) == {child.backend_pid}
        child.kill()
        env.observer.wait_backend_gone(child.backend_pid)
        assert env.observer.holders("organisation", negative) == set()
        assert env.observer.holders("tenant", positive) == set()


def test_control_a_late_child_reply_never_reaches_the_next_call(transactional_db: None) -> None:
    with open_queue_env("real") as env:
        child = env.process_actor("control")
        slow = child.send("execute", statements=["SELECT pg_sleep(2)"])
        with pytest.raises(BarrierError):
            slow.result(timeout=0.1)
        assert child.call("session") == child.backend_pid, (
            "a reply to a timed-out request was delivered to the next call"
        )


# ------------------------------------------------------------------------- counterexamples ----


@pytest.mark.parametrize("binding", ["permissive", "inert"])
@pytest.mark.parametrize("identifier", sorted(INVENTORY))
def test_every_acceptance_test_fails_a_broken_queue_with_its_exact_message(
    identifier: str, binding: str, transactional_db: None
) -> None:
    row = INVENTORY[identifier]
    function = getattr(acceptance, row["function"])
    with open_queue_env(binding) as env, pytest.raises(AssertionError) as caught:
        function(env)
    assert _first_line(caught.value) == row[binding], (
        f"{identifier} failed the {binding} queue with {_first_line(caught.value)!r}, "
        f"not the exact message its row names ({row[binding]!r})"
    )


class _DropNamedAssertion(ast.NodeTransformer):
    """Replace every `assert` in one function whose message is exactly the named one with `pass`."""

    def __init__(self, function: str, message: str) -> None:
        self.function = function
        self.message = message
        self.inside = False
        self.dropped = 0

    def visit_FunctionDef(self, node: ast.FunctionDef) -> ast.AST:
        outer = self.inside
        self.inside = outer or node.name == self.function
        self.generic_visit(node)
        self.inside = outer
        return node

    def visit_Assert(self, node: ast.Assert) -> ast.AST:
        if self.inside and isinstance(node.msg, ast.Constant) and node.msg.value == self.message:
            self.dropped += 1
            return ast.copy_location(ast.Pass(), node)
        return node


@pytest.mark.parametrize("identifier", sorted(INVENTORY))
def test_deleting_the_named_assertion_changes_how_the_permissive_queue_fails(
    identifier: str, transactional_db: None
) -> None:
    """The proof above is not satisfied by any failure: remove the assertion the permissive queue is
    named to fail, and that queue no longer fails the test with it."""
    row = INVENTORY[identifier]
    source = Path(acceptance.__file__).read_text(encoding="utf-8")
    transformer = _DropNamedAssertion(row["function"], row["permissive"])
    tree = ast.fix_missing_locations(transformer.visit(ast.parse(source)))
    assert transformer.dropped == 1, (
        f"{identifier}: {transformer.dropped} assertions carry the permissive queue's named message"
    )
    namespace: dict[str, object] = {"__name__": f"weakened_{identifier.replace('-', '_')}"}
    exec(compile(tree, acceptance.__file__, "exec"), namespace)  # noqa: S102 - the repository's own test source
    outcome: BaseException | None = None
    with open_queue_env("permissive") as env:
        try:
            namespace[row["function"]](env)  # type: ignore[operator]
        except Exception as error:  # noqa: BLE001 - any outcome is recorded and judged below
            outcome = error
    assert outcome is None or _first_line(outcome) != row["permissive"], (
        f"{identifier}: with its named assertion deleted, the permissive queue still failed with "
        "that assertion, so the proof does not rest on it"
    )


# --------------------------------------------------------------------------- mutant flags ----
# docs/specs/JOB_QUEUE.md §9.2: every row of mutants.toml is a committed test-only flag on apps.jobs,
# run against the real queue and caught by its owning test with its exact message.

MUTANT_ROWS: list[dict[str, str]] = tomllib.loads(MUTANTS_PATH.read_text(encoding="utf-8"))[
    "mutant"
]
PROVABLE = [row for row in MUTANT_ROWS if INVENTORY[row["test"]]["state"] == "pass"]
GUARDED_PACKAGES = ("apps/jobs", "apps/outbox", "apps/audit")
EXTRA_BINDINGS_REFUSAL = (
    "JOB_QUEUE_EXTRA_BINDINGS is set: a binding outside the repository could stand in for the queue"
)


def _prove_flag(flag: str, test: str, message: str, function: Callable[[Any], None]) -> None:
    """Run `function` on the real queue with `flag` active, restore every database guard, and
    require the flag to be caught by an assertion carrying exactly `message`. The case starts from
    the migrated guards and no active flag, or it fails before it runs: what an earlier case left
    behind is reported here, not as this flag's verdict."""
    from django.db import connection

    from apps.jobs import mutants

    with connection.cursor() as cursor:
        snapshot = database_mutants.snapshot_guards(cursor)
    differences = database_mutants.pristine_differences(snapshot)
    assert differences == [], (
        f"{flag}: the database guards are not the migrated ones before the case: "
        f"{'; '.join(differences)}"
    )
    left_active = sorted(mutants.active())
    assert left_active == [], f"{flag}: {', '.join(left_active)} is active before the case"
    outcome: BaseException | None = None
    try:
        with open_queue_env("real:" + flag) as env:
            function(env)
    except Exception as error:  # noqa: BLE001 - judged below
        outcome = error
    finally:
        mutants.deactivate()
        with connection.cursor() as cursor:
            database_mutants.restore_database(cursor, snapshot)
            restored = database_mutants.snapshot_guards(cursor)
    assert restored == snapshot, f"{flag}: a database mutant was left installed"
    assert isinstance(outcome, AssertionError), (
        f"{flag} was not caught by {test} with an assertion: {outcome!r}"
    )
    assert _first_line(outcome) == message, (
        f"{flag} was caught by {test} with {_first_line(outcome)!r}, not its row's message"
    )


@pytest.mark.parametrize("row", PROVABLE, ids=lambda row: row["flag"])
def test_every_mutant_flag_is_caught_by_its_owning_test_on_the_real_queue(
    row: dict[str, str], transactional_db: None
) -> None:
    function = getattr(acceptance, INVENTORY[row["test"]]["function"])
    _prove_flag(row["flag"], row["test"], row["message"], function)


def _passes(env: Any) -> None:
    """An owning test that nothing fails: what a flag that disables no guard leaves."""


def test_the_runner_fails_a_flag_that_disables_nothing(
    transactional_db: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    from apps.jobs import mutants

    monkeypatch.setattr(mutants, "FLAGS", mutants.FLAGS | {"selftest_disables_nothing"})
    with pytest.raises(AssertionError) as caught:
        _prove_flag("selftest_disables_nothing", "A3-01", "anything", _passes)
    assert _first_line(caught.value) == (
        "selftest_disables_nothing was not caught by A3-01 with an assertion: None"
    )


def test_the_runner_fails_a_database_mutant_left_installed(
    transactional_db: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    from django.db import connection

    with connection.cursor() as cursor:
        snapshot = database_mutants.snapshot_guards(cursor)
    monkeypatch.setattr(database_mutants, "restore_database", lambda cursor, snapshot: None)
    try:
        with pytest.raises(AssertionError) as caught:
            _prove_flag("freeze_skips_category", "A3-13", "anything", _passes)
    finally:
        monkeypatch.undo()
        with connection.cursor() as cursor:
            database_mutants.restore_database(cursor, snapshot)
            assert database_mutants.snapshot_guards(cursor) == snapshot
    assert (
        _first_line(caught.value) == "freeze_skips_category: a database mutant was left installed"
    )


def test_the_runner_fails_a_flag_caught_with_another_message(transactional_db: None) -> None:
    def fails_later(env: Any) -> None:
        raise AssertionError("a later message of the same test")

    with pytest.raises(AssertionError) as caught:
        _prove_flag("no_promotion", "A3-11", "the row's message", fails_later)
    assert _first_line(caught.value) == (
        "no_promotion was caught by A3-11 with 'a later message of the same test', "
        "not its row's message"
    )


def test_the_runner_fails_a_case_that_starts_with_a_guard_disarmed(transactional_db: None) -> None:
    """A mutant an earlier case left installed is reported by the case that finds it, before that
    case runs: its own restore would return the guards to that same disarmed snapshot."""
    from django.db import connection

    from apps.jobs import mutants

    with connection.cursor() as cursor:
        snapshot = database_mutants.snapshot_guards(cursor)
        database_mutants.install_database_mutant(cursor, "freeze_skips_category")
    try:
        with pytest.raises(AssertionError) as caught:
            _prove_flag("no_promotion", "A3-11", "anything", _passes)
    finally:
        mutants.deactivate()
        with connection.cursor() as cursor:
            database_mutants.restore_database(cursor, snapshot)
            assert database_mutants.snapshot_guards(cursor) == snapshot
    assert _first_line(caught.value) == (
        "no_promotion: the database guards are not the migrated ones before the case: "
        "outbox_delivery_guard has a disarmed guard marker"
    )


def test_the_runner_fails_a_case_that_starts_with_a_flag_active(transactional_db: None) -> None:
    from apps.jobs import mutants

    mutants.activate("no_dedupe")
    try:
        with pytest.raises(AssertionError) as caught:
            _prove_flag("no_promotion", "A3-11", "anything", _passes)
    finally:
        mutants.deactivate()
    assert _first_line(caught.value) == "no_promotion: no_dedupe is active before the case"


# One mutant of a trigger's marker and one of a table's constraint: the two kinds of guard.
@pytest.mark.parametrize("flag", ["freeze_skips_category", "start_check_skips_in_flight"])
def test_the_real_queue_refuses_to_open_on_a_disarmed_guard(
    flag: str, transactional_db: None
) -> None:
    """An acceptance row opens the real queue on the migrated guards, or not at all: a database
    mutant a failed restore left installed would otherwise answer under the real queue's name."""
    from django.db import connection

    with connection.cursor() as cursor:
        snapshot = database_mutants.snapshot_guards(cursor)
        database_mutants.install_database_mutant(cursor, flag)
        differences = database_mutants.pristine_differences(
            database_mutants.snapshot_guards(cursor)
        )
    try:
        with pytest.raises(AssertionError) as caught, open_queue_env("real"):
            pass
    finally:
        with connection.cursor() as cursor:
            database_mutants.restore_database(cursor, snapshot)
            assert database_mutants.snapshot_guards(cursor) == snapshot
    assert len(differences) == 1, f"{flag} changes {len(differences)} guards, not one"
    assert str(caught.value) == (
        f"the real queue's database guards are not the migrated ones: {differences[0]}"
    )
    if flag == "freeze_skips_category":
        assert differences == ["outbox_delivery_guard has a disarmed guard marker"]
    else:
        rewrite = database_mutants.DATABASE_MUTANTS[flag]
        assert isinstance(rewrite, database_mutants.CheckRewrite)
        assert differences[0].startswith(f"{rewrite.table}.{rewrite.constraint} is "), differences
    with open_queue_env("real"):
        pass


def test_the_real_binding_reads_no_guard_on_a_tree_missing_a_queue_application(
    transactional_db: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """On a tree that lacks one of the queue's applications a row reports that gap: the binding
    must not fail first on a guard that application's migrations own."""
    from django.db import connection

    monkeypatch.setattr(RealBinding, "APPS", (*RealBinding.APPS, ABSENT_APP))
    with connection.cursor() as cursor:
        snapshot = database_mutants.snapshot_guards(cursor)
        database_mutants.install_database_mutant(cursor, "freeze_skips_category")
    try:
        RealBinding.install(connection)
    finally:
        with connection.cursor() as cursor:
            database_mutants.restore_database(cursor, snapshot)
            assert database_mutants.snapshot_guards(cursor) == snapshot


def test_the_real_binding_refuses_to_be_built_while_a_flag_is_active() -> None:
    """The unflagged binding is the queue every acceptance row measures: a flag an earlier case left
    active would make it a mutant under the real queue's name."""
    from apps.jobs import mutants

    mutants.activate("no_dedupe")
    try:
        with pytest.raises(AssertionError) as caught:
            RealBinding()
        flagged = binding_class("real:no_dedupe")()
    finally:
        mutants.deactivate()
    assert str(caught.value) == "the real binding was built while no_dedupe is active"
    assert flagged.flag == "no_dedupe"
    assert RealBinding().flag == ""


def test_every_mutant_row_has_a_registered_flag_and_nothing_else_is_registered() -> None:
    from apps.jobs import mutants

    assert mutants.FLAGS == {row["flag"] for row in MUTANT_ROWS}, (
        "the committed flags and mutants.toml differ"
    )


def _guard_call_counts(
    packages: tuple[str, ...] = GUARDED_PACKAGES, root: Path = ROOT
) -> collections.Counter[str]:
    """How many times each flag is read through a literal `on("<flag>")` in the three apps'
    sources."""
    found: collections.Counter[str] = collections.Counter()
    for package in packages:
        for path in sorted((root / package).rglob("*.py")):
            for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
                if (
                    isinstance(node, ast.Call)
                    and (
                        (isinstance(node.func, ast.Name) and node.func.id == "on")
                        or (isinstance(node.func, ast.Attribute) and node.func.attr == "on")
                    )
                    and len(node.args) == 1
                    and isinstance(node.args[0], ast.Constant)
                    and isinstance(node.args[0].value, str)
                ):
                    found[node.args[0].value] += 1
    return found


def _guard_call_sites(packages: tuple[str, ...] = GUARDED_PACKAGES) -> set[str]:
    """Every literal flag read through `on("<flag>")` in the three apps' sources."""
    return set(_guard_call_counts(packages))


def _flags_that_disable_nothing(
    flags: set[str], call_sites: set[str], database: set[str]
) -> list[str]:
    return [
        f"{flag} has no guard: no on({flag!r}) call site and no database mutant"
        for flag in sorted(flags - call_sites - database)
    ]


def test_every_flag_of_a_passing_test_disables_a_guard() -> None:

    provable = {row["flag"] for row in PROVABLE}
    assert (
        _flags_that_disable_nothing(
            provable, _guard_call_sites(), set(database_mutants.DATABASE_MUTANTS)
        )
        == []
    )


def test_the_guard_check_names_a_flag_that_disables_nothing() -> None:
    assert _flags_that_disable_nothing({"a", "b", "c"}, {"a"}, {"b"}) == [
        "c has no guard: no on('c') call site and no database mutant"
    ]
    assert "ghost" not in _guard_call_sites(), "a flag no source reads was found as a call site"


HEADER_COUNTS = {
    word: number
    for number, word in enumerate(
        (
            "One Two Three Four Five Six Seven Eight Nine Ten Eleven Twelve Thirteen Fourteen "
            "Fifteen Sixteen Seventeen Eighteen Nineteen Twenty"
        ).split(),
        start=1,
    )
}
CODE_AND_DATABASE = "rows disable a function's clause and the database guard"
MOVED_STATEMENT = "rows move one statement"
HEADER_ROW = re.compile(r"#   ([a-z0-9_]+)\s")


def _listed(header: str, paragraph: str) -> tuple[int | None, set[str]] | None:
    """The count the header's paragraph holding `paragraph` states, and the rows it lists; None
    when the header has no such paragraph."""
    lines = header.splitlines()
    start = next((n for n, line in enumerate(lines) if paragraph in line), None)
    if start is None:
        return None
    count = HEADER_COUNTS.get(lines[start].removeprefix("# ").split(" ", 1)[0])
    listed: set[str] = set()
    for line in lines[start + 1 :]:
        if listed and not line.startswith("#  "):
            break
        found = HEADER_ROW.match(line)
        if found:
            listed.add(found.group(1))
    return count, listed


def _code_and_database_rows(header: str, both: set[str]) -> list[str]:
    """Where the header's list of rows that disable a clause in the code and a database guard
    differs from the flags both read by `on("<flag>")` and installed as a database mutant."""
    paragraph = _listed(header, CODE_AND_DATABASE)
    if paragraph is None:
        return ["the header has no paragraph for rows read in the code and in the database"]
    count, listed = paragraph
    problems = [
        f"{flag} disables a clause in the code and a database guard, and the header does not list it"
        for flag in sorted(both - listed)
    ]
    problems += [
        f"the header lists {flag}, which is not read both in the code and in the database"
        for flag in sorted(listed - both)
    ]
    if count != len(listed):
        problems.append(f"the header counts {count} such rows but lists {len(listed)}")
    return problems


def test_the_header_lists_every_row_read_in_the_code_and_in_the_database() -> None:

    header = (HERE / "mutants.toml").read_text(encoding="utf-8").split("\nformat = ", 1)[0]
    both = _guard_call_sites() & set(database_mutants.DATABASE_MUTANTS)
    assert _code_and_database_rows(header, both) == [], (
        "the mutants.toml header misstates the rows read in the code and in the database"
    )


def test_the_header_check_names_an_unlisted_row_and_a_wrong_count() -> None:
    header = (
        "# Three rows disable a function's clause and the database guard that would refuse\n"
        "# what the mutant then writes:\n"
        "#   a                 the first\n"
        "#                     continued\n"
        "#   b                 the second\n"
        "# Four rows replace a path\n"
    )
    assert _code_and_database_rows(header, {"a", "c"}) == [
        "c disables a clause in the code and a database guard, and the header does not list it",
        "the header lists b, which is not read both in the code and in the database",
        "the header counts 3 such rows but lists 2",
    ]
    assert _code_and_database_rows("# nothing\n", set()) == [
        "the header has no paragraph for rows read in the code and in the database"
    ]


def _moved_statement_rows(header: str, read_twice: set[str]) -> list[str]:
    """Where the header's list of rows that read their flag at more than one place differs from
    the flags the code reads through more than one literal `on("<flag>")`."""
    paragraph = _listed(header, MOVED_STATEMENT)
    if paragraph is None:
        return ["the header has no paragraph for rows read at more than one place in the code"]
    count, listed = paragraph
    problems = [
        f"{flag} is read at more than one place in the code, and the header does not list it"
        for flag in sorted(read_twice - listed)
    ]
    problems += [
        f"the header lists {flag} as read at more than one place in the code, which it is not"
        for flag in sorted(listed - read_twice)
    ]
    if count != len(listed):
        problems.append(f"the header counts {count} such rows but lists {len(listed)}")
    return problems


def test_the_header_lists_every_row_read_at_more_than_one_place_in_the_code() -> None:
    """One flag read at two places disables two guards unless the two are one statement moved:
    a flag nobody listed would hide that a test observes only one of them."""
    header = (HERE / "mutants.toml").read_text(encoding="utf-8").split("\nformat = ", 1)[0]
    read_twice = {flag for flag, reads in _guard_call_counts().items() if reads > 1}
    assert _moved_statement_rows(header, read_twice) == [], (
        "the mutants.toml header misstates the rows read at more than one place in the code"
    )


def test_the_moved_statement_check_names_an_unlisted_row_and_a_wrong_count(
    tmp_path: Path,
) -> None:
    header = (
        "# Three rows move one statement, and so read their flag at two places, where the\n"
        "# statement leaves and where it goes:\n"
        "#   a                 the first\n"
        "#   b                 the second\n"
        "# Four rows replace a path\n"
    )
    assert _moved_statement_rows(header, {"a", "c"}) == [
        "c is read at more than one place in the code, and the header does not list it",
        "the header lists b as read at more than one place in the code, which it is not",
        "the header counts 3 such rows but lists 2",
    ]
    assert _moved_statement_rows("# nothing\n", set()) == [
        "the header has no paragraph for rows read at more than one place in the code"
    ]
    # The count itself: one flag read in two functions of two modules is read twice.
    package = tmp_path / "apps" / "jobs"
    package.mkdir(parents=True)
    (package / "claim.py").write_text('def complete():\n    return mutants.on("shared")\n')
    (package / "runner.py").write_text(
        'def dispatch():\n    return on("shared") or mutants.on("alone")\n'
    )
    assert _guard_call_counts(("apps/jobs",), tmp_path) == {"shared": 2, "alone": 1}, (
        "a flag read at two places was not counted twice"
    )


# The header's paragraphs of rows that replace rather than delete, and the name that sets the rows
# of a group apart; a path is replaced by rows no name identifies.
SUBSTITUTION_GROUPS: tuple[tuple[str, re.Pattern[str] | None], ...] = (
    ("rows replace a path", None),
    ("rows replace a lock mode", re.compile(r"_locks_for_update$")),
    ("rows swap two checks", re.compile(r"_checked_before_")),
)
HEADER_NAMES = re.compile(r"#   \S")


def _named(header: str, phrase: str) -> tuple[int | None, set[str]] | None:
    """The count the header paragraph holding `phrase` opens with and every word of its name
    lines, which list several rows to a line or one row before its description; None when the
    header has no such paragraph. A description's continuation line, indented further, names no
    row. A description that names another row on its name line counts that row as listed."""
    lines = header.splitlines()
    start = next((n for n, line in enumerate(lines) if phrase in line), None)
    if start is None:
        return None
    count = HEADER_COUNTS.get(lines[start].removeprefix("# ").split(" ", 1)[0])
    listed: set[str] = set()
    indented = False
    for line in lines[start + 1 :]:
        if line.startswith("#  "):
            indented = True
            if HEADER_NAMES.match(line):
                listed |= set(re.findall(r"[a-z0-9_]+", line))
        elif indented:
            break
    return count, listed


def _substitution_rows(header: str, flags: set[str]) -> list[str]:
    """Where the header's lists of rows that replace rather than delete differ from the rows: a
    count that is not its list's length; for a group a name identifies, a row of that name the
    list leaves out, a listed row of another name, and a listed name of that form that is no row;
    and, among the paths, a row whose name puts it in another group."""
    problems = []
    for phrase, name in SUBSTITUTION_GROUPS:
        found = _named(header, phrase)
        if found is None:
            problems.append(f"the header has no paragraph of {phrase!r}")
            continue
        count, words = found
        listed = words & flags
        if name is None:
            problems += [
                f"the header lists {flag} among the {phrase!r}, and its name puts it among the "
                f"{other!r}"
                for other, pattern in SUBSTITUTION_GROUPS
                if pattern is not None
                for flag in sorted(listed)
                if pattern.search(flag)
            ]
        else:
            named = {flag for flag in flags if name.search(flag)}
            problems += [
                f"{flag} is one of the {phrase!r} and the header does not list it"
                for flag in sorted(named - listed)
            ]
            problems += [
                f"the header lists {flag} among the {phrase!r}, which its name does not say"
                for flag in sorted(listed - named)
            ]
            problems += [
                f"the header lists {word} among the {phrase!r}, which is no row"
                for word in sorted(words - flags)
                if name.search(word)
            ]
        if count != len(listed):
            problems.append(f"the header counts {count} {phrase!r} but lists {len(listed)}")
    return problems


def test_the_header_lists_every_row_that_replaces_a_lock_mode_or_swaps_two_checks() -> None:
    header = (HERE / "mutants.toml").read_text(encoding="utf-8").split("\nformat = ", 1)[0]
    assert _substitution_rows(header, {row["flag"] for row in MUTANT_ROWS}) == [], (
        "the mutants.toml header misstates the rows that replace rather than delete"
    )


def test_the_substitution_check_names_an_unlisted_row_and_a_wrong_count() -> None:
    header = (
        "# Three rows replace a path, because that is the only form their guard has:\n"
        "#   first_path        the first\n"
        "#                     continued, naming a_locks_for_update in passing\n"
        "# Two rows replace a lock mode, every row named <site>_locks_for_update: the guard IS\n"
        "# the mode:\n"
        "#   a_locks_for_update, first_path, ghost_locks_for_update\n"
        "# Other rows\n"
        "#   b_checked_before_c\n"
    )
    flags = {"first_path", "a_locks_for_update", "z_locks_for_update", "b_checked_before_c"}
    assert _substitution_rows(header, flags) == [
        "the header counts 3 'rows replace a path' but lists 1",
        "z_locks_for_update is one of the 'rows replace a lock mode' and the header does not "
        "list it",
        "the header lists first_path among the 'rows replace a lock mode', which its name does "
        "not say",
        "the header lists ghost_locks_for_update among the 'rows replace a lock mode', which is "
        "no row",
        "the header has no paragraph of 'rows swap two checks'",
    ]
    misplaced = (
        "# Two rows replace a path:\n"
        "#   first_path, a_locks_for_update\n"
        "# One rows replace a lock mode:\n"
        "#   a_locks_for_update\n"
        "# One rows swap two checks:\n"
        "#   b_checked_before_c\n"
    )
    assert _substitution_rows(misplaced, flags - {"z_locks_for_update"}) == [
        "the header lists a_locks_for_update among the 'rows replace a path', and its name puts "
        "it among the 'rows replace a lock mode'",
    ]


GUARD_MARKER = re.compile(r"/\*guard:([a-z0-9_]+)\*/")
DISARMED_MARKER = re.compile(r"/\*guard:([a-z0-9_]+)\*/ false")


def _disarmed(definitions: dict[str, str]) -> set[str]:
    return {name for text in definitions.values() for name in DISARMED_MARKER.findall(text)}


def _unlisted_markers(
    definitions: dict[str, str], database: set[str], unrowed: set[str]
) -> list[str]:
    markers = {name for text in definitions.values() for name in GUARD_MARKER.findall(text)}
    return [
        f"the guard marker {name} is neither a database flag nor an unrowed marker"
        for name in sorted(markers - database - unrowed)
    ]


def test_every_guard_marker_is_a_database_flag(transactional_db: None) -> None:
    """Every /*guard:<name>*/ in a guard's live definition is a database flag, or a marker Task 1
    wrote for a row Task 10 adds (database_mutants.UNROWED_MARKERS)."""
    from django.db import connection

    with connection.cursor() as cursor:
        definitions = database_mutants.snapshot_guards(cursor)
    database = set(database_mutants.DATABASE_MUTANTS)
    assert _unlisted_markers(definitions, database, set(database_mutants.UNROWED_MARKERS)) == []
    assert not database_mutants.UNROWED_MARKERS & database, (
        "a marker is both unrowed and a database flag"
    )
    # §9.2: every guard the specification owes has its row before the implementation merges.
    assert sorted(database_mutants.UNROWED_MARKERS) == [], "a guard marker has no mutant row"


def test_the_marker_check_names_an_unlisted_marker() -> None:
    definitions = {"function f": "IF /*guard:a*/ true OR /*guard:b*/ true OR /*guard:c*/ true"}
    assert _unlisted_markers(definitions, {"a"}, {"b"}) == [
        "the guard marker c is neither a database flag nor an unrowed marker"
    ]


def test_every_database_mutant_changes_its_guard_and_restores_to_the_migrated_one(
    transactional_db: None,
) -> None:
    """Each database flag, installed, changes the live guards; re-installing over another first
    re-arms the migrated guards; and the restore returns them exactly to the migration's text."""
    from django.db import connection

    with connection.cursor() as cursor:
        migrated = database_mutants.snapshot_guards(cursor)
        try:
            assert database_mutants.pristine_differences(migrated) == [], (
                "mutants.py's pristine constraints differ from the migrated database"
            )
            for flag in sorted(database_mutants.DATABASE_MUTANTS):
                database_mutants.install_database_mutant(cursor, flag)
                installed = database_mutants.snapshot_guards(cursor)
                assert installed != migrated, (
                    f"{flag}: installing its database mutant changed nothing"
                )
                # Exactly the markers this flag disarms are false: a marker the previous flag left
                # disarmed shows here. Two flags may disarm the same markers (Marker.names), so
                # comparing with the previous snapshot would prove nothing for them.
                mutant = database_mutants.DATABASE_MUTANTS[flag]
                expected = (
                    set(mutant.names or (flag,))
                    if isinstance(mutant, database_mutants.Marker)
                    else set()
                )
                assert _disarmed(installed) == expected, (
                    f"{flag}: the previous database mutant was not re-armed"
                )
                changed = {key for key in migrated if installed[key] != migrated[key]}
                assert len(changed) == 1, f"{flag}: its database mutant changed {sorted(changed)}"
        finally:
            database_mutants.restore_database(cursor, migrated)
        assert database_mutants.snapshot_guards(cursor) == migrated, (
            "the restore left a guard changed"
        )


def test_a_database_mutant_whose_marker_moved_is_refused(transactional_db: None) -> None:
    from django.db import connection

    from apps.jobs import mutants

    with connection.cursor() as cursor:
        migrated = database_mutants.snapshot_guards(cursor)
        with pytest.raises(mutants.MutantsRefused) as caught:
            database_mutants.apply_marker(
                cursor,
                database_mutants.Marker("outbox_delivery_guard", 3),
                "delivery_exit_any_transaction",
            )
        assert database_mutants.snapshot_guards(cursor) == migrated
    assert str(caught.value) == (
        "delivery_exit_any_transaction occurs 2 times in outbox_delivery_guard, not 3"
    )


def test_a_database_mutant_naming_a_missing_marker_is_refused_whole(
    transactional_db: None,
) -> None:
    """A flag that disarms other markers than its own is refused, with nothing disarmed, when one
    of them is not in its function: the markers found before it are not left disarmed."""
    from django.db import connection

    from apps.jobs import mutants

    with connection.cursor() as cursor:
        migrated = database_mutants.snapshot_guards(cursor)
        with pytest.raises(mutants.MutantsRefused) as caught:
            database_mutants.apply_marker(
                cursor,
                database_mutants.Marker(
                    "jobs_job_guard", names=("place_may_be_cleared", "moved_marker")
                ),
                "orphan_loses_place",
            )
        assert database_mutants.snapshot_guards(cursor) == migrated, (
            "a refused marker set disarmed a guard"
        )
    assert str(caught.value) == "moved_marker occurs 0 times in jobs_job_guard, not 1"


def test_no_binding_outside_the_repository_stands_in_for_the_queue() -> None:
    assert "JOB_QUEUE_EXTRA_BINDINGS" not in os.environ, EXTRA_BINDINGS_REFUSAL


def test_the_extra_bindings_check_fails_a_run_that_sets_them() -> None:
    result = _child_pytest(
        _rooted(
            f"{Path(__file__)}::test_no_binding_outside_the_repository_stands_in_for_the_queue"
        ),
        {**_child_environment(), "JOB_QUEUE_EXTRA_BINDINGS": "selftest_extra_bindings"},
    )
    assert result.returncode == 1, result.stdout[-2000:]
    assert f"AssertionError: {EXTRA_BINDINGS_REFUSAL}" in result.stdout, result.stdout[-2000:]


def test_extra_bindings_are_refused_under_ci(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JOB_QUEUE_EXTRA_BINDINGS", "selftest_extra_bindings")
    monkeypatch.setenv("CI", "true")
    with pytest.raises(LookupError) as caught:
        binding_class("selftest_no_such_binding")
    assert str(caught.value) == (
        "JOB_QUEUE_EXTRA_BINDINGS is refused under CI: no binding outside the repository "
        "stands in for the queue"
    )


def test_a_flagged_binding_activates_its_flag_and_a_database_flag_installs_its_mutant(
    transactional_db: None,
) -> None:
    from django.conf import settings
    from django.db import connection

    from apps.jobs import mutants

    with connection.cursor() as cursor:
        snapshot = database_mutants.snapshot_guards(cursor)
    try:
        binding = binding_class("real:freeze_skips_category")
        assert (
            binding.name == "real:freeze_skips_category" and binding.flag == "freeze_skips_category"
        )
        binding()
        assert mutants.on("freeze_skips_category") and not mutants.on("no_promotion")
        assert settings.JOB_QUEUE_MUTANTS == frozenset({"freeze_skips_category"})
        with connection.cursor() as cursor:
            binding.install(connection)
            assert database_mutants.snapshot_guards(cursor) != snapshot
    finally:
        mutants.deactivate()
        with connection.cursor() as cursor:
            database_mutants.restore_database(cursor, snapshot)
    assert not mutants.on("freeze_skips_category")
    assert settings.JOB_QUEUE_MUTANTS == frozenset()


# Regression coverage for diagnostic preservation without weakening the strict gap binding.
# Uses its actual _copy_directory/_xfail_copy/_child_pytest helpers and normal pytest fixtures.
TEARDOWN_DIAGNOSTIC_SENTINEL = "A3_TEARDOWN_DIAGNOSTIC_CONTROL"
TEARDOWN_DIAGNOSTIC_HEADING = "Original job-queue teardown failure"
TEARDOWN_DIAGNOSTIC_PREFIX = "test_a3_31_"


def _install_teardown_diagnostic_control(copy: Path, *, fail: bool) -> None:
    path = copy / "test_job_queue_acceptance.py"
    text = path.read_text(encoding="utf-8")
    name = "test_a3_31_a_decision_needs_a_staff_principal_holding_a_current_operator_grant"
    start = text.index(f"def {name}(")
    signature = "    queue_env: QueueEnv,\n) -> None:"
    at = text.index(signature, start)
    assert at < text.index("    env = queue_env\n", start)
    text = text[:at] + "    teardown_diagnostic_control: None,\n" + text[at:]
    text += (
        "\n\n@pytest.fixture\ndef teardown_diagnostic_control():\n"
        "    yield\n"
        f"    if {fail!r}:\n"
        f"        raise RuntimeError({TEARDOWN_DIAGNOSTIC_SENTINEL!r})\n"
    )
    # The acceptance module currently imports no pytest; this temp copy alone needs its fixture.
    text = text.replace(
        "from queue_harness import (", "import pytest\nfrom queue_harness import (", 1
    )
    path.write_text(text, encoding="utf-8")


def test_original_teardown_diagnostic_survives_the_strict_real_hook(tmp_path: Path) -> None:
    """A real body gap plus fixture teardown failure stays XFAIL+ERROR, with original cause."""
    for name, fail in [("before", False), ("failure", True), ("after", False)]:
        copy = _xfail_copy(tmp_path / name)
        _install_teardown_diagnostic_control(copy, fail=fail)
        completed = _child_pytest(
            _rooted(str(copy / "test_job_queue_acceptance.py")),
            {**_child_environment(), "CI": "true"},
        )
        output = completed.stdout + completed.stderr
        lines = [
            line
            for line in output.splitlines()
            if f"::{TEARDOWN_DIAGNOSTIC_PREFIX}" in line
            and line.split(" ")[0] in {"XFAIL", "ERROR", "FAILED", "PASSED", "XPASS", "SKIPPED"}
        ]
        if fail:
            assert completed.returncode == 1, output[-8192:]
            assert len(lines) == 2 and {line.split(" ")[0] for line in lines} == {
                "XFAIL",
                "ERROR",
            }, output[-8192:]
            assert "A3-31 failed in teardown: only the test body may reach the gap" in output
            assert TEARDOWN_DIAGNOSTIC_HEADING in output, "CORE_REAL_TEARDOWN_ORIGINAL_SECTION"
            assert "RuntimeError" in output and TEARDOWN_DIAGNOSTIC_SENTINEL in output, (
                "CORE_REAL_TEARDOWN_ORIGINAL_CAUSE"
            )
        else:
            assert completed.returncode == 0, output[-8192:]
            assert len(lines) == 1 and lines[0].startswith("XFAIL "), output[-8192:]
            assert TEARDOWN_DIAGNOSTIC_HEADING not in output


def test_parent_unique_outcome_refusal_exposes_the_original_teardown_cause(tmp_path: Path) -> None:
    """Exercise the actual nested parent assertion, not a tolerant replacement outcome parser."""
    copy = _copy_directory(tmp_path / "parent", selftest=True)
    _install_teardown_diagnostic_control(copy, fail=True)
    # Only this actual parent is selected in the outer child. Its own inner copied acceptance
    # run retains CI=true, all the exact existing escape controls and untouched-row refusals.
    completed = _child_pytest(
        _rooted(
            str(copy / "test_job_queue_selftest.py")
            + "::test_the_binding_refuses_every_escape_in_a_real_run"
        ),
        _child_environment(),
    )
    output = completed.stdout + completed.stderr
    assert completed.returncode == 1, output[-8192:]
    assert "has 2 summary lines" in output, "CORE_PARENT_STILL_REJECTS_MIXED_OUTCOMES"
    assert "A3-31 failed in teardown: only the test body may reach the gap" in output
    assert TEARDOWN_DIAGNOSTIC_SENTINEL in output, "CORE_REAL_PARENT_TEARDOWN_DIAGNOSTIC"
    assert len(output) < 4 * 1024 * 1024, "CHILD_DIAGNOSTIC_OUTPUT_BUDGET"
