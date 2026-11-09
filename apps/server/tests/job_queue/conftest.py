"""Bind every job-queue acceptance test to its row in `acceptance.toml`, and refuse any other outcome.

An acceptance test carries one `job_queue_acceptance` identifier and no marker of its own that could
skip or excuse it. An `xfail` row runs under a strict expected failure, and in every phase the only
accepted report is the call raising exactly `QueueGapError` with the row's gap — one of the harness's
closed list, raised by the harness's own gap probe, still missing when measured again: a pass,
another exception, a gap raised by a fixture or forged in the test, a skip, `pytest.xfail()`, a
`[NOTRUN]` expected failure, `--runxfail` and `-p no:skipping` each fail the run by name. A `pass` row runs plainly,
and a skip or an expected failure of it in any phase fails the run.

Two rules hold for the run as a whole, and neither fails a `--collect-only` run:

- **Collection.** A collector under this directory that is skipped or fails — a module-level
  `pytest.skip`, a failing `pytest.importorskip`, an import error — fails the run: a module that
  yields no test would otherwise silence every row in it. No test file lives here but the acceptance
  module and the self-test, and any other test item under this directory is refused.
- **Call reports.** Every inventory row must produce a call report. Missing reports fail the run
  when the environment variable `CI` is set, or when the run selected nothing: no `-k`, `-m`,
  `--deselect`, `--lf`, `--ff`, node id narrower than this directory, and no stop by `-x` or
  `--maxfail`. A developer's narrowed run elsewhere gets one notice line instead. Either way the
  line names the remedy: run the directory `tests/job_queue`.

`JOB_QUEUE_COLLECTION_REPORT=<path>` writes, for each collected acceptance test, the expected-failure
binding it received, so the self-test can prove the binding from a real collection.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest
from queue_harness import HERE, MARKER, QueueGapError, open_queue_env
from queue_inventory import ACCEPTANCE_MODULE, INVENTORY, SELFTEST_MODULE, pass_verdict, verdict

ROW = pytest.StashKey[dict[str, Any]]()
REFUSAL = pytest.StashKey[str]()
DESELECTED = pytest.StashKey[list[str]]()
CALLED = pytest.StashKey[set[str]]()
VISITED = pytest.StashKey[bool]()
UNCOLLECTED = pytest.StashKey[list[str]]()
OWN_MARKS = ("xfail", "skip", "skipif")
REMEDY = "run the directory `tests/job_queue`"


def _here(path: Any) -> bool:
    found = Path(str(path)).resolve()
    return found == HERE or HERE in found.parents


def _acceptance(item: pytest.Item) -> bool:
    path = Path(str(item.path)).resolve()
    return path.parent == HERE and path.name == ACCEPTANCE_MODULE


def _selftest(item: pytest.Item) -> bool:
    path = Path(str(item.path)).resolve()
    return path.parent == HERE and path.name == SELFTEST_MODULE


@pytest.hookimpl(wrapper=True)
def pytest_make_collect_report(collector: pytest.Collector) -> Any:
    """Whether this directory was in the run's scope is read from the collection itself, not from
    the items it yielded: a module skipped or broken at import yields none."""
    report = yield
    if _here(collector.path):
        collector.config.stash[VISITED] = True
        if report.outcome != "passed":
            reason = str(report.longrepr)
            if isinstance(report.longrepr, tuple):
                reason = str(report.longrepr[2])
            collector.config.stash.setdefault(UNCOLLECTED, []).append(
                f"{collector.nodeid} was {report.outcome} at collection "
                f"({reason.strip().splitlines()[-1][:160]})"
            )
    return report


def identifier(item: pytest.Item) -> str | None:
    marks = list(item.iter_markers(MARKER))
    if len(marks) != 1 or len(marks[0].args) != 1 or marks[0].kwargs:
        return None
    value = marks[0].args[0]
    return value if isinstance(value, str) else None


@pytest.hookimpl(tryfirst=True)
def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    report: list[dict[str, Any]] = []
    for item in items:
        if not _acceptance(item):
            if _here(item.path) and (not _selftest(item) or list(item.iter_markers(MARKER))):
                item.stash[REFUSAL] = (
                    f"{item.nodeid} is a test under tests/job_queue that is neither an inventory "
                    "row of the acceptance module nor the self-test: it is bound to nothing"
                )
            continue
        found = identifier(item)
        if found is None:
            item.stash[REFUSAL] = f"{item.nodeid} carries no single {MARKER} identifier"
            continue
        row = INVENTORY.get(found)
        if row is None:
            item.stash[REFUSAL] = f"{found} is collected but absent from the inventory"
            continue
        if row["function"] != item.name:
            item.stash[REFUSAL] = f"{found} is bound to {row['function']}, not {item.name}"
            continue
        own = [mark.name for name in OWN_MARKS for mark in item.iter_markers(name)]
        if own:
            item.stash[REFUSAL] = (
                f"{found} carries its own {own[0]} marker, which the inventory owns"
            )
            continue
        if getattr(config.option, "runxfail", False):
            item.stash[REFUSAL] = f"{found} cannot run under --runxfail, which ignores its binding"
            continue
        if not config.pluginmanager.has_plugin("skipping"):
            # Without that plugin `xfail` is not even a registered marker: say so, by name, rather
            # than let `pytest.mark.xfail` end the run in an internal error under --strict-markers.
            item.stash[REFUSAL] = (
                f"{found} cannot run with pytest's skipping plugin disabled (-p no:skipping), "
                "which is what applies its binding"
            )
            continue
        item.stash[ROW] = row
        item.add_marker(pytest.mark.django_db(transaction=True))
        if row["state"] == "xfail":
            item.add_marker(
                pytest.mark.xfail(
                    strict=True,
                    raises=QueueGapError,
                    reason=f"{found} not built, gap {row['gap']}",
                )
            )
        report.append(
            {
                "id": found,
                "function": item.name,
                "xfail": [
                    {
                        "strict": mark.kwargs.get("strict"),
                        "raises": getattr(mark.kwargs.get("raises"), "__name__", None),
                    }
                    for mark in item.iter_markers("xfail")
                ],
            }
        )
    destination = os.environ.get("JOB_QUEUE_COLLECTION_REPORT")
    if destination:
        Path(destination).write_text(json.dumps(report), encoding="utf-8")


def pytest_deselected(items: list[pytest.Item]) -> None:
    for item in items:
        found = identifier(item) if _acceptance(item) else None
        if found is not None:
            item.config.stash.setdefault(DESELECTED, []).append(found)


def pytest_runtest_setup(item: pytest.Item) -> None:
    refusal = item.stash.get(REFUSAL, None)
    if refusal is not None:
        pytest.fail(refusal, pytrace=False)


def _original_teardown_diagnostic(report: Any, row_name: str, error: Any) -> str:
    """Keep the original test failure alongside the strict verdict, without locals."""
    try:
        original = str(report.longrepr)
    except Exception as formatting_error:  # noqa: BLE001 - formatting must not excuse a failed phase
        original = (
            f"Original diagnostic unavailable ({type(formatting_error).__name__}); "
            f"exception={type(error).__name__}"
        )
    text = f"[{row_name}]\n{original}"
    marker = "\n... [diagnostic truncated] ...\n"
    if len(text) > 4096:
        left = (4096 - len(marker)) // 2
        right = 4096 - len(marker) - left
        return text[:left] + marker + text[-right:]
    return text


@pytest.hookimpl(wrapper=True)
def pytest_runtest_makereport(item: pytest.Item, call: pytest.CallInfo[None]) -> Any:
    report = yield
    refusal = item.stash.get(REFUSAL, None)
    if refusal is not None and report.when == "setup":
        # Refused before it ran; an excusing marker must not turn that refusal into an xfail.
        report.outcome = "failed"
        report.longrepr = refusal
        if hasattr(report, "wasxfail"):
            del report.wasxfail
        found = identifier(item) if _acceptance(item) else None
        if found is not None:
            # It failed by its own sentence: it is not also a row the run left uncalled.
            item.config.stash.setdefault(CALLED, set()).add(found)
        return report
    row = item.stash.get(ROW, None)
    if row is None:
        return report
    if report.when == "call":
        item.config.stash.setdefault(CALLED, set()).add(row["id"])
    if row["state"] == "pass":
        refused = pass_verdict(
            row,
            when=report.when,
            outcome=report.outcome,
            wasxfail=getattr(report, "wasxfail", None),
        )
        if refused is not None:
            report.outcome = "failed"
            report.longrepr = refused
            if hasattr(report, "wasxfail"):
                del report.wasxfail
        return report
    message = verdict(
        row,
        when=report.when,
        outcome=report.outcome,
        wasxfail=getattr(report, "wasxfail", None),
        error=call.excinfo.value if call.excinfo is not None else None,
        origin=str(call.excinfo.traceback[-1].path) if call.excinfo is not None else None,
    )
    if message is not None:
        if report.when == "teardown":
            report.sections.append(
                (
                    "Original job-queue teardown failure",
                    _original_teardown_diagnostic(
                        report, row["id"], call.excinfo.value if call.excinfo is not None else None
                    ),
                )
            )
        report.outcome = "failed"
        report.longrepr = message
        if hasattr(report, "wasxfail"):
            del report.wasxfail
        if report.when == "setup":
            item.config.stash.setdefault(CALLED, set()).add(row["id"])
    return report


def _collect_only(config: pytest.Config) -> bool:
    return bool(getattr(config.option, "collectonly", False))


def _uncalled(config: pytest.Config) -> list[str]:
    if _collect_only(config) or not config.stash.get(VISITED, False):
        return []
    called: set[str] = config.stash.get(CALLED, set())
    return sorted(set(INVENTORY) - called)


def _uncollected(config: pytest.Config) -> list[str]:
    found: list[str] = config.stash.get(UNCOLLECTED, [])
    return [] if _collect_only(config) else found


def _narrowed(session: pytest.Session) -> str | None:
    """The selection this run made, if any: what excuses a missing call report outside CI."""
    option = session.config.option
    for name, flag in (
        ("keyword", "-k"),
        ("markexpr", "-m"),
        ("deselect", "--deselect"),
        ("lf", "--lf"),
        ("failedfirst", "--ff"),
    ):
        if getattr(option, name, None):
            return flag
    for argument in session.config.args:
        path = Path(str(argument).split("::", 1)[0]).resolve()
        if "::" in str(argument) and _here(path):
            return "a node id"
        if path != HERE and HERE in path.parents:
            return "a path inside the directory"
    if session.shouldfail or session.shouldstop:
        return "-x or --maxfail"
    return None


MUST_REPORT = pytest.StashKey[bool]()


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    config = session.config
    strict = bool(os.environ.get("CI")) or _narrowed(session) is None
    config.stash[MUST_REPORT] = strict
    # Only a run that would otherwise succeed becomes a failure: an interrupted run, an internal
    # error or a usage error keeps the status that names it.
    if session.exitstatus not in (pytest.ExitCode.OK, pytest.ExitCode.NO_TESTS_COLLECTED):
        return
    if _uncollected(config) or (strict and _uncalled(config)):
        session.exitstatus = pytest.ExitCode.TESTS_FAILED


def pytest_terminal_summary(terminalreporter: Any, exitstatus: int, config: pytest.Config) -> None:
    for line in _uncollected(config):
        terminalreporter.write_line(
            f"FAILED: tests/job_queue was not collected whole: {line}. Every acceptance row is "
            f"silenced by a module that yields no test; {REMEDY} once it collects.",
            red=True,
        )
    uncalled = _uncalled(config)
    if not uncalled:
        return
    dropped: list[str] = config.stash.get(DESELECTED, [])
    deselected = sorted(set(dropped))
    detail = f" (deselected: {', '.join(deselected)})" if deselected else ""
    if config.stash.get(MUST_REPORT, True):
        terminalreporter.write_line(
            "FAILED: a run that visited tests/job_queue produced no call report for job-queue "
            f"acceptance rows: {', '.join(uncalled)}{detail}. A run may not deselect, ignore or "
            f"trim a row: {REMEDY}.",
            red=True,
        )
    else:
        terminalreporter.write_line(
            "NOTICE: this narrowed run produced no call report for job-queue acceptance rows: "
            f"{', '.join(uncalled)}{detail}. That fails under CI and in an unnarrowed run; to see "
            f"them, {REMEDY}.",
            yellow=True,
        )


@pytest.fixture(scope="session")
def django_db_modify_db_settings(django_db_modify_db_settings_parallel_suffix: None) -> None:
    """A child run of the binding proof gets its own test database, never the parent's."""
    suffix = os.environ.get("JOB_QUEUE_TEST_DATABASE_SUFFIX", "")
    if not suffix:
        return
    from django.conf import settings

    for database in settings.DATABASES.values():
        test = database.setdefault("TEST", {})
        test["NAME"] = f"{test.get('NAME') or 'test_' + database['NAME']}_{suffix}"


@pytest.fixture(scope="session")
def django_db_setup(django_db_setup: None) -> Any:
    """Drop the test database without the application's 2 s statement budget.

    DROP DATABASE waits on a forced checkpoint whose length grows with the WAL the whole suite wrote
    since the last one: 2.3 s after 170 MB on a CI runner, against 0.4 s after 52 MB. That is the
    disposable server's housekeeping, not an application statement, and it decided whether a child
    run's last test errored in teardown. Every test statement keeps the budget: this runs after the
    last test, and only the connection Django opens to drop the database reads it."""
    yield
    from django.db import connections

    for connection in connections.all():
        options = connection.settings_dict.setdefault("OPTIONS", {})
        options["options"] = f"{options.get('options', '')} -c statement_timeout=0".strip()


@pytest.fixture
def queue_env(transactional_db: None) -> Any:
    with open_queue_env("real") as env:
        yield env
