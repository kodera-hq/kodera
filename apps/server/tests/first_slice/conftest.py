"""Bind every collected first-slice scenario to the inventory, and refuse any other outcome.

A scenario test carries one `first_slice_scenario` identifier and nothing else. Its state comes
from `scenarios.toml`: a `pass` row runs plainly; an `xfail` or `blocked` row runs under a strict
expected failure that accepts only a `ScenarioGapError`, and then only the gap the row records. So a
scenario that starts passing, turns red for another reason, skips, or is decorated with its own
xfail fails the run by name.

A population run must run all of them. Whenever the population check is selected, or a filter
deselected a scenario while others still run, the session fails unless every mandatory scenario
produced a result, naming the ones that did not. `-m`, `-k` and `--deselect` cannot make CI green.
The collected population itself is compared with the inventory by the population check in
`test_first_slice_harness_selftest.py`, which is what notices a deleted scenario.

Before any scenario runs, the environment is admitted: a configured external provider endpoint, a
public identity issuer or an unreachable PostgreSQL refuses the run.

Environment inputs, all optional:
- `FIRST_SLICE_CASE=FS-BOOT-01` runs one scenario and refuses an identifier that is not mandatory.
- `FIRST_SLICE_REQUIRE_PASS=1` fails the run unless every selected scenario passed.
- `FIRST_SLICE_COLLECTION_REPORT=<path>` writes the collected identifiers as JSON.
- `FIRST_SLICE_TEST_DATABASE_SUFFIX` and `FIRST_SLICE_NO_DATABASE`, for the harness's own child
  runs: a separate test database, or none, in which case any database access fails.
"""

import json
import os
from pathlib import Path
from typing import Any

import pytest
from first_slice_harness import (
    HERE,
    ID_PATTERN,
    INVENTORY_PATH,
    MARKER,
    POPULATION_TEST,
    BlockedOnDecisionError,
    FirstSliceHarness,
    Inventory,
    InventoryError,
    ScenarioGapError,
    ScenarioRow,
    SelectionError,
    admission_refusals,
    failure_summary,
    incomplete_population,
    load_inventory,
    select_case,
    verdict,
)

try:
    INVENTORY = load_inventory(INVENTORY_PATH.read_text(encoding="utf-8"))
except InventoryError as error:
    raise pytest.UsageError(f"first-slice inventory {INVENTORY_PATH}: {error}") from None

ROW = pytest.StashKey[ScenarioRow]()
REFUSAL = pytest.StashKey[str]()
RESULTS = pytest.StashKey[dict[str, tuple[str, str]]]()
SELECTED = pytest.StashKey[list[str]]()
DESELECTED = pytest.StashKey[set[str]]()
POPULATION = pytest.StashKey[bool]()
CASE = pytest.StashKey[str | None]()
SESSION_FAILURES = pytest.StashKey[list[str]]()


def _here(item: pytest.Item) -> bool:
    return Path(str(item.path)).resolve().is_relative_to(HERE)


def _identifier(item: pytest.Item) -> tuple[str | None, bool]:
    marks = list(item.iter_markers(MARKER))
    if not marks:
        return None, False
    if len(marks) != 1 or len(marks[0].args) != 1 or marks[0].kwargs:
        return None, True
    value = marks[0].args[0]
    if not isinstance(value, str) or ID_PATTERN.fullmatch(value) is None:
        return None, True
    return value, False


def pytest_collection_modifyitems(
    session: pytest.Session, config: pytest.Config, items: list[pytest.Item]
) -> None:
    config.stash[RESULTS] = {}
    config.stash.setdefault(DESELECTED, set())
    local = [item for item in items if _here(item)]
    if local:
        refusals = admission_refusals(os.environ)
        if refusals:
            raise pytest.UsageError("first-slice admission refused: " + "; ".join(refusals))
    collected: list[dict[str, str]] = []
    malformed: list[str] = []
    unmarked: list[str] = []
    for item in local:
        if "harness" in getattr(item, "fixturenames", ()) and not os.environ.get(
            "FIRST_SLICE_NO_DATABASE"
        ):
            # Declared statically, never requested lazily: pytest-django creates a test database
            # only for aliases some collected item declares, and a lazy request from a run with no
            # such item would reach the configured database itself.
            item.add_marker(pytest.mark.django_db(transaction=True))
        scenario_id, bad = _identifier(item)
        if bad:
            malformed.append(item.nodeid)
            item.stash[REFUSAL] = f"{item.nodeid} carries a malformed scenario identifier"
            continue
        if scenario_id is None:
            if Path(str(item.path)).name.startswith("test_fs_"):
                unmarked.append(item.nodeid)
                item.stash[REFUSAL] = f"{item.nodeid} is a scenario-file test with no identifier"
            continue
        collected.append({"id": scenario_id, "nodeid": item.nodeid})
        _bind(item, scenario_id, INVENTORY)

    ids = [entry["id"] for entry in collected]
    for item in local:
        scenario_id, _ = _identifier(item)
        if scenario_id is not None and ids.count(scenario_id) > 1:
            item.stash[REFUSAL] = f"{scenario_id} is collected by {ids.count(scenario_id)} tests"

    report = os.environ.get("FIRST_SLICE_COLLECTION_REPORT")
    if report:
        Path(report).write_text(
            json.dumps(
                {"format": 1, "scenarios": collected, "malformed": malformed, "unmarked": unmarked}
            ),
            encoding="utf-8",
        )

    try:
        case = select_case(os.environ.get("FIRST_SLICE_CASE"), INVENTORY.ids)
    except SelectionError as error:
        raise pytest.UsageError(str(error)) from None
    config.stash[CASE] = case
    if case is not None:
        keep = [item for item in items if not _here(item) or _identifier(item)[0] == case]
        dropped = [item for item in items if item not in keep]
        if dropped:
            config.hook.pytest_deselected(items=dropped)
        items[:] = keep


def pytest_deselected(items: list[pytest.Item]) -> None:
    for item in items:
        if not _here(item):
            continue
        scenario_id, _ = _identifier(item)
        if scenario_id is not None:
            item.config.stash.setdefault(DESELECTED, set()).add(scenario_id)


def pytest_collection_finish(session: pytest.Session) -> None:
    """Record what is left after every filter: pytest's own deselection runs after ours."""
    local = [item for item in session.items if _here(item)]
    session.config.stash[POPULATION] = any(item.name == POPULATION_TEST for item in local)
    session.config.stash[SELECTED] = [
        scenario_id for item in local if (scenario_id := _identifier(item)[0]) is not None
    ]


def _bind(item: pytest.Item, scenario_id: str, inventory: Inventory) -> None:
    try:
        row = inventory.row(scenario_id)
    except KeyError:
        item.stash[REFUSAL] = f"{scenario_id} is collected but absent from the inventory"
        return
    item.stash[ROW] = row
    if row.state == "xfail":
        item.add_marker(
            pytest.mark.xfail(
                strict=True,
                raises=ScenarioGapError,
                reason=f"{row.id} not built, gap {row.gap}: {row.reason}",
            )
        )
    elif row.state == "blocked":
        decision = inventory.decisions[str(row.gap).removeprefix("decision:")]
        item.add_marker(
            pytest.mark.xfail(
                strict=True,
                raises=BlockedOnDecisionError,
                reason=f"{row.id} BLOCKED on decision {decision.key} ({decision.title}): {row.reason}",
            )
        )


def pytest_runtest_setup(item: pytest.Item) -> None:
    refusal = item.stash.get(REFUSAL, None)
    if refusal is not None:
        pytest.fail(refusal, pytrace=False)


@pytest.hookimpl(wrapper=True)
def pytest_runtest_makereport(item: pytest.Item, call: pytest.CallInfo[None]) -> Any:
    report = yield
    row = item.stash.get(ROW, None)
    if row is None:
        if item.stash.get(REFUSAL, None) is not None and report.when == "setup":
            _record(item, "", "failed", item.stash[REFUSAL])
        return report
    wasxfail = hasattr(report, "wasxfail")
    exc = call.excinfo.value if call.excinfo is not None else None
    xpass = report.failed and str(report.longrepr).startswith("[XPASS(strict)]")
    if report.when in ("setup", "teardown") and report.passed:
        return report
    label, message = verdict(row, outcome=report.outcome, wasxfail=wasxfail, exc=exc, xpass=xpass)
    if message is not None:
        report.outcome = "failed"
        report.longrepr = message
        if wasxfail:
            del report.wasxfail
    report.user_properties.append(("first_slice_state", label))
    if message is not None:
        detail = message
    elif label == "passed unexpectedly":
        detail = f"passed while the inventory records gap {row.gap}"
    elif label == "failed":
        detail = failure_summary(exc) or str(report.longrepr).strip().splitlines()[0][:200]
    else:
        detail = failure_summary(exc)
    _record(item, row.id, label, detail)
    return report


def _record(item: pytest.Item, scenario_id: str, label: str, detail: str) -> None:
    results = item.config.stash.setdefault(RESULTS, {})
    key = scenario_id or item.nodeid
    if key not in results or label == "failed":
        results[key] = (label, detail)


def pytest_report_teststatus(report: pytest.TestReport, config: pytest.Config) -> Any:
    if dict(report.user_properties).get("first_slice_state") == "blocked" and report.skipped:
        return "blocked", "B", "BLOCKED"
    return None


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    """Fail a population run that left a mandatory scenario without a result, or unmet acceptance."""
    config = session.config
    if config.option.collectonly or session.exitstatus not in (
        pytest.ExitCode.OK,
        pytest.ExitCode.TESTS_FAILED,
    ):
        return
    results = config.stash.get(RESULTS, {})
    case = config.stash.get(CASE, None)
    selected = config.stash.get(SELECTED, [])
    deselected = config.stash.get(DESELECTED, set())
    failures = []
    population = config.stash.get(POPULATION, False)
    if case is None and (population or (deselected and selected)):
        message = incomplete_population(INVENTORY.ids, results, deselected)
        if message is not None:
            failures.append(message)
    if os.environ.get("FIRST_SLICE_REQUIRE_PASS"):
        wanted = [case] if case is not None else list(INVENTORY.ids)
        passed = [sid for sid in wanted if results.get(sid, ("", ""))[0] == "passed"]
        if len(passed) != len(wanted):
            failures.append(
                f"first-slice acceptance is not met: {len(passed)} of {len(wanted)} mandatory "
                "scenarios passed, and FIRST_SLICE_REQUIRE_PASS accepts nothing less"
            )
    if failures:
        config.stash[SESSION_FAILURES] = failures
        session.exitstatus = pytest.ExitCode.TESTS_FAILED


def pytest_terminal_summary(terminalreporter: Any, exitstatus: int, config: pytest.Config) -> None:
    results = config.stash.get(RESULTS, {})
    selected = config.stash.get(SELECTED, [])
    failures = config.stash.get(SESSION_FAILURES, [])
    if not selected and not results and not failures:
        return
    writer = terminalreporter
    writer.section("first-slice acceptance scenarios")
    writer.write_line(
        f"inventory: {INVENTORY_PATH.relative_to(HERE.parents[1])} ({INVENTORY.transcribed_from})"
    )
    counts: dict[str, int] = {}
    for row in INVENTORY.rows:
        label, detail = results.get(row.id, ("not run", ""))
        counts[label] = counts.get(label, 0) + 1
        if label == "blocked":
            decision = INVENTORY.decisions[str(row.gap).removeprefix("decision:")]
            suffix = f"decision {decision.key}: {decision.title}"
        elif label in ("failed", "passed unexpectedly"):
            suffix = detail.splitlines()[0][:200] if detail else ""
        else:
            suffix = row.gap or ""
        writer.write_line(f"  {row.id:<14} {label:<20} {suffix}")
    for key, (label, detail) in results.items():
        if not key.startswith("FS-"):
            writer.write_line(f"  {label}: {detail}")
    order = ("passed", "xfail", "blocked", "failed", "passed unexpectedly", "not run")
    line = ", ".join(f"{counts[name]} {name}" for name in order if counts.get(name))
    writer.write_line(f"  {line} (of {len(INVENTORY.rows)} mandatory)")
    if counts.get("not run"):
        writer.write_line("  a partial run is not first-slice acceptance")
    for failure in failures:
        writer.write_line(f"  FAILED: {failure}", red=True)


@pytest.fixture(scope="session")
def django_db_modify_db_settings(django_db_modify_db_settings_parallel_suffix: None) -> None:
    """A child run of the mutation proofs gets its own test database, never the parent's."""
    suffix = os.environ.get("FIRST_SLICE_TEST_DATABASE_SUFFIX", "")
    if not suffix:
        return
    from django.conf import settings

    for database in settings.DATABASES.values():
        test = database.setdefault("TEST", {})
        test["NAME"] = f"{test.get('NAME') or 'test_' + database['NAME']}_{suffix}"
        # Several children create, migrate and drop a database at once on a loaded runner: the
        # two-second statement bound of a live connection would refuse a CREATE or DROP DATABASE
        # there, and a child would report its teardown instead of its scenarios. A child proves
        # how scenarios are classified, and each stops at its gap before any lock wait.
        options = database.setdefault("OPTIONS", {})
        options["options"] = "-c statement_timeout=30000"


@pytest.fixture
def harness(request: pytest.FixtureRequest, settings: Any) -> Any:
    instance = FirstSliceHarness(request=request, settings=settings, inventory=INVENTORY)
    with instance.running():
        yield instance
