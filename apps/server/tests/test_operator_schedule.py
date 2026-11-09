"""run_operator_schedule: docs/specs/OPERATOR_SCHEDULE.md §4."""

import re
from io import StringIO

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from apps.orgs.management.commands import run_operator_schedule as schedule

NAMES = [name for name, _ in schedule.RUNS]


@pytest.fixture(autouse=True)
def closed(monkeypatch):
    """No database here: the connection hygiene between runs is counted, not run."""
    count = []
    monkeypatch.setattr(schedule, "close_old_connections", lambda: count.append(1))
    return count


class Never:
    requested = False


def runner(outcomes, calls):
    def run(name, *args, stdout, stderr):
        calls.append((name, args))
        outcome = outcomes.get(name)
        if isinstance(outcome, Exception):
            raise outcome
        stdout.write(f"{name} counts=1\n")

    return run


def command():
    return schedule.Command(stdout=StringIO(), stderr=StringIO())


def test_a_pass_runs_the_revocation_first_and_the_mail_within_its_budget(closed):
    calls = []
    report = command().run_pass(Never(), runner({}, calls))
    assert calls == [
        ("run_realm_deliveries", ("--once",)),
        ("send_invitations", ("--once",)),
        ("send_support_tickets", ("--once",)),
        ("run_deliveries", ("--once", "--budget-s", "20")),
    ]
    assert (report.ok, report.failed) == (4, 0)
    # A connection one run broke never fails the next.
    assert len(closed) == 4


def test_a_refused_run_does_not_hold_back_the_next(caplog):
    calls = []
    outcomes = {"send_invitations": CommandError("no contact seal key")}
    report = command().run_pass(Never(), runner(outcomes, calls))
    assert [name for name, _ in calls] == NAMES
    assert (report.ok, report.failed) == (3, 1)
    assert "send_invitations refused: no contact seal key" in caplog.text


def test_a_deployment_without_a_support_mailbox_still_delivers_the_other_mails(caplog):
    calls = []
    refused = CommandError("support ticket mails refused: no support mailbox")
    report = command().run_pass(Never(), runner({"send_support_tickets": refused}, calls))
    assert [name for name, _ in calls] == NAMES
    assert calls[-1][0] == "run_deliveries"
    assert (report.ok, report.failed) == (3, 1)
    assert "send_support_tickets refused: support ticket mails refused" in caplog.text


def test_a_crash_is_logged_by_its_class_only(caplog):
    outcomes = {"send_invitations": RuntimeError("postgres://user:secret@db")}
    report = command().run_pass(Never(), runner(outcomes, []))
    assert report.failed == 1
    assert "send_invitations failed: RuntimeError" in caplog.text
    assert "secret" not in caplog.text


def test_each_run_s_line_is_printed_under_its_name():
    cmd = command()
    cmd.run_pass(Never(), runner({}, []))
    assert cmd.stdout._out.getvalue().splitlines() == [f"{name}: {name} counts=1" for name in NAMES]


def test_a_stop_ends_the_pass_before_the_next_run():
    class StopAfterFirst:
        requested = False

    stop, calls = StopAfterFirst(), []

    def run(name, *args, stdout, stderr):
        calls.append(name)
        stop.requested = True

    command().run_pass(stop, run)
    assert calls == NAMES[:1]


@pytest.mark.parametrize(
    ("arguments", "message"),
    [
        (["--interval", "9"], "--interval must be 10 to 3600 seconds"),
        (["--interval", "3601"], "--interval must be 10 to 3600 seconds"),
        (["--passes", "-1"], "--passes must be 0 or more"),
    ],
)
def test_bounds_are_refused(arguments, message, settings):
    with pytest.raises(CommandError, match=message):
        call_command("run_operator_schedule", *arguments)


def test_passes_bounds_the_loop(monkeypatch):
    seen = []
    monkeypatch.setattr(
        schedule.Command, "run_pass", lambda self, stop: seen.append(1) or schedule.PassReport(3)
    )
    monkeypatch.setattr(schedule._Stop, "wait", lambda self, seconds: None)
    out = StringIO()
    call_command("run_operator_schedule", "--passes", "2", "--interval", "10", stdout=out)
    assert len(seen) == 2
    lines = out.getvalue().splitlines()
    assert [re.sub(r" at=\S+$", "", line) for line in lines] == [
        "pass 1 ok=3 failed=0",
        "pass 2 ok=3 failed=0",
    ]
    # Each pass line carries the time it ended, which a staleness alert reads.
    assert all(re.search(r" at=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$", line) for line in lines)
