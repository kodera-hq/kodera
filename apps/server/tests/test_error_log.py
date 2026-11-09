"""An uncaught exception in a view writes exactly one line to stderr, and the line carries no secret.

tests/log_probe.py runs in its own process under these settings, so the LOGGING under test is the
one Django applies at start, not a copy. The last test weakens each clause of LOGGING and of
core.logs.JsonLine in turn and requires the assertion that owns it to be the one that fails.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
from django.conf import settings
from log_probe import ITEM, SECRET

PROBE = Path(__file__).with_name("log_probe.py")


def probe(mutation: str = "") -> list[str]:
    """The probe's stderr, one entry per line."""
    done = subprocess.run(  # noqa: S603 - our own probe, a fixed interpreter and arguments
        [sys.executable, str(PROBE), mutation],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
        env={**os.environ, "DJANGO_SETTINGS_MODULE": settings.SETTINGS_MODULE},
        cwd=PROBE.parents[1],
    )
    assert done.returncode == 0, f"the probe did not run: {done.stderr[-2000:]}"
    return done.stderr.splitlines()


def check(lines: list[str]) -> None:
    assert len(lines) == 2, (
        f"expected two lines (the 500 and the warning), got {len(lines)}: {lines}"
    )
    for line in lines:
        assert SECRET not in line and "bob@example.com" not in line, f"a secret reached: {line}"
        assert ITEM not in line, f"the request path reached: {line}"
    try:
        error, warning = (json.loads(line) for line in lines)
    except json.JSONDecodeError as refused:
        raise AssertionError(f"a line is not one JSON object: {refused}") from None
    assert {
        key: error.get(key) for key in ("level", "logger", "event", "method", "route", "status")
    } == {
        "level": "ERROR",
        "logger": "django.request",
        "event": "request.failed",
        "method": "POST",
        "route": "probe/<uuid:item>/explode",
        "status": 500,
    }, f"the 500's line: {error}"
    chain: list[dict[str, Any]] = error["exception"]
    assert [link["type"] for link in chain] == ["KeyError", "RuntimeError"], f"the chain: {chain}"
    assert [f["function"] for f in chain[1]["frames"]][-1] == "explode", f"the frames: {chain}"
    assert {key: warning.get(key) for key in ("level", "logger", "event")} == {
        "level": "WARNING",
        "logger": "apps.probe",
        "event": "probe.warned %s",
    }, f"the warning's line: {warning}"


def test_an_uncaught_exception_writes_one_line_and_no_secret() -> None:
    check(probe())


# Each weakening, and the start of the message of the assertion that must refuse it.
MUTATIONS = {
    # Python's last resort then prints the warning alone, argument and all: main before this file.
    "no-logging": "expected two lines (the 500 and the warning), got 1",
    "no-root-handler": "expected two lines (the 500 and the warning), got 1",
    "handler-level-notset": "expected two lines (the 500 and the warning), got 3",
    "handler-level-error": "expected two lines (the 500 and the warning), got 1",
    "request-at-warning": "expected two lines (the 500 and the warning), got 3",
    "existing-loggers-disabled": "expected two lines (the 500 and the warning), got 1",
    "plain-formatter": "expected two lines (the 500 and the warning), got ",
    "not-json": "a line is not one JSON object",
    "message-interpolated": "the request path reached",
    "exception-message": "a secret reached",
    "path-logged": "a secret reached",
    "authorization-logged": "a secret reached",
}


@pytest.mark.parametrize("mutation", sorted(MUTATIONS))
def test_each_weakening_is_refused_by_its_own_assertion(mutation: str) -> None:
    lines = probe(mutation)
    with pytest.raises(AssertionError) as refused:
        check(lines)
    assert str(refused.value).startswith(MUTATIONS[mutation]), str(refused.value)
