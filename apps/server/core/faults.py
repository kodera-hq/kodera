"""Named fault points: where the first-slice harness crashes or holds Core (FIRST_SLICE_G1.md, G1.4).

A *site* is one `faults.reach("<site>")` call at a transaction or dispatch boundary. A *point* is a
name the harness arms; it selects a site and a mode:

- crash: `reach()` raises `SimulatedCrash`, a BaseException, so no `except Exception` in Core
  swallows it and every transaction it leaves rolls back, as a killed process's would;
- hold: `reach()` sets the barrier's `reached` and waits on its `released`, inside the transaction,
  so a contender meets the transaction still open.

Inert unless armed: `reach()` returns at once while nothing is armed, and `arm()` is refused unless
the process runs `config.settings.test` with `FAULT_POINTS_PERMITTED`, gated exactly as
`apps/jobs/mutants.py` gates its flags. No other settings module names that permission
(tests/test_job_queue_flags_refused.py) and the deployment profile refuses an arm
(tests/test_production_runtime.py). This module holds no credential and makes no call (ADR-0003).

`tests/first_slice/fault_points.toml` records every point and site, and
`dev/check_first_slice_fault_points.py` holds the tree to it: one `reach()` per site, at the function
the inventory names, every point armed by a first-slice scenario or real-worker acceptance test.

Armed from outside the process (G1.4 lane decision D5, built in G1.5-B): a harness that cannot reach
into the worker writes `armed.json` into a control directory and starts the worker with
`KODERA_FAULT_CONTROL=<dir>`. `load_control()` reads that variable only after the same gate as
`arm()`, and every deployed profile refuses any `KODERA_FAULT_*` name at start
(config/deploy_environment.py). A point armed that way writes `reached/<point>` when it is reached,
and its mode is `crash` or `kill`: in `kill` it waits there, and the harness that sees the file
kills the worker's process group, so the crash is a real `SIGKILL`, not a simulated one.
"""

from __future__ import annotations

import json
import os
import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Literal, Protocol

from django.conf import Settings, UserSettingsHolder, settings
from django.core.exceptions import ImproperlyConfigured

TEST_SETTINGS = "config.settings.test"
# How long a held site waits for its release before it crashes instead: a hold never released is a
# wrong scenario, and a transaction left open for ever would hang the run. Longer than the
# harness's own release deadline (3 x BARRIER_SECONDS = 30 s), so the harness always speaks first.
HOLD_SECONDS = 45.0
# Out-of-process arming: the one variable it reads, the prefix every deployed profile refuses, the
# file the harness writes and the directory the armed process writes into.
CONTROL = "KODERA_FAULT_CONTROL"
CONTROL_PREFIX = "KODERA_FAULT_"
ARMED_FILE = "armed.json"
REACHED_DIRECTORY = "reached"
# A point armed from outside crashes in process, or waits at its site to be killed from outside.
CONTROL_MODES = ("crash", "kill")


@dataclass(frozen=True)
class Point:
    site: str
    mode: Literal["crash", "hold"]


POINTS = MappingProxyType(
    {
        "intake:after-desired-state": Point("intake:after-desired-state", "crash"),
        "intake:after-audit": Point("intake:after-audit", "crash"),
        "intake:after-job": Point("intake:after-job", "crash"),
        "intake:before-commit": Point("intake:before-commit", "crash"),
        "intake:hold-before-commit": Point("intake:before-commit", "hold"),
        "intake:after-commit": Point("intake:after-commit", "crash"),
        # Lane decision D2: under ADR-0004 dispatch is a worker's claim, so nothing in this process
        # lies between the commit and the dispatch; the name is an alias of the same site.
        "intake:after-commit-before-dispatch": Point("intake:after-commit", "crash"),
        "realm_create:after-provider-success-before-acknowledgement": Point(
            "realm_create:after-provider-success-before-acknowledgement", "crash"
        ),
        "worker:after-failed-dispatch-close-before-step-record": Point(
            "worker:after-failed-dispatch-close-before-step-record", "crash"
        ),
        "worker:after-recovered-failed-step": Point("worker:after-recovered-failed-step", "crash"),
        "worker:inside-completed-ack-before-step": Point(
            "worker:inside-completed-ack-before-step", "crash"
        ),
        "worker:after-completed-ack": Point("worker:after-completed-ack", "crash"),
        "worker:after-completion-claim-projection": Point(
            "worker:after-completion-claim-projection", "crash"
        ),
    }
)


# Every site, in the order POINTS names them: derived, so the two cannot drift.
SITES = tuple(dict.fromkeys(point.site for point in POINTS.values()))


class FaultPointsRefused(ImproperlyConfigured):
    """A point was armed where these settings do not permit one, or is no point."""


class SimulatedCrash(BaseException):  # noqa: N818 - a crash, not an error to handle
    """The process died at `point`. A BaseException: nothing in Core may catch it as an error."""

    def __init__(self, point: str, site: str) -> None:
        super().__init__(f"simulated crash at fault point {point} (site {site})")
        self.point = point
        self.site = site


class Barrier(Protocol):
    reached: threading.Event
    released: threading.Event


@dataclass
class _Armed:
    point: str
    mode: str
    barrier: Barrier | None
    hits: int = 0
    # The control directory of a point armed from outside the process, None for arm().
    control: Path | None = None


_lock = threading.Lock()
# site -> what is armed there. Process-global: the harness races requests on threads.
_armed: dict[str, _Armed] = {}


def _settings_profile() -> object:
    """The configured profile through ordinary test overrides: apps/jobs/mutants.py's reading."""
    getattr(settings, "SETTINGS_MODULE", None)  # Initialize LazySettings before reading its holder.
    holder = vars(settings).get("_wrapped")
    while isinstance(holder, UserSettingsHolder):
        values = vars(holder)
        if "SETTINGS_MODULE" in values.get("_deleted", set()):
            return None
        if "SETTINGS_MODULE" in values and values["SETTINGS_MODULE"] != TEST_SETTINGS:
            return None
        holder = holder.default_settings
    return getattr(holder, "SETTINGS_MODULE", None) if isinstance(holder, Settings) else None


def _require_permitted() -> None:
    if (
        os.environ.get("DJANGO_SETTINGS_MODULE") != TEST_SETTINGS
        or _settings_profile() != TEST_SETTINGS
        or getattr(settings, "FAULT_POINTS_PERMITTED", False) is not True
    ):
        raise FaultPointsRefused("fault points are refused: these settings do not permit them")


def reach(site: str) -> None:
    """Called once at `site`. Does nothing unless a point on that site is armed."""
    if not _armed:
        return
    with _lock:
        entry = _armed.get(site)
        if entry is None:
            return
        entry.hits += 1
    if entry.control is not None:
        _record_reached(entry)
    if entry.mode == "kill":
        # The harness kills this process group once it reads reached/<point>: this never returns
        # unless it fails to, and then the run ends here as a crash rather than going on.
        time.sleep(HOLD_SECONDS)
        raise SimulatedCrash(entry.point, site)
    if entry.mode == "crash" or entry.barrier is None:
        raise SimulatedCrash(entry.point, site)
    entry.barrier.reached.set()
    if not entry.barrier.released.wait(HOLD_SECONDS):
        raise SimulatedCrash(entry.point, site)


def require_permitted() -> None:
    """The gate every test-only switch of a process shares: arm(), load_control(), the worker's
    mutant flags (worker/mutants.py) and the synthetic provider's key (worker/providers/synthetic.py).
    Raises FaultPointsRefused unless the process runs config.settings.test with the permission."""
    _require_permitted()


def write_atomically(path: Path, text: str) -> None:
    """Write `path` whole or not at all: a harness polling for it never reads half a file. The
    temporary name is hidden and ends in `.tmp`, so no `*.json` glob and no exact name sees it."""
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(text, encoding="utf-8")
    os.replace(temporary, path)


def _record_reached(entry: _Armed) -> None:
    assert entry.control is not None  # noqa: S101 - only a point armed from outside records
    reached = entry.control / REACHED_DIRECTORY
    reached.mkdir(exist_ok=True)
    write_atomically(reached / entry.point, json.dumps({"pid": os.getpid(), "hits": entry.hits}))


def load_control(environment: Mapping[str, str]) -> Path | None:
    """Arm the points a harness outside this process wrote into `KODERA_FAULT_CONTROL`'s
    `armed.json`; None when no `KODERA_FAULT_*` name is set. The gate comes before any value of
    the environment or any file is read: a profile that does not permit fault points stops here."""
    names = sorted(name for name in environment if name.startswith(CONTROL_PREFIX))
    if not names:
        return None
    _require_permitted()
    if names != [CONTROL]:
        raise FaultPointsRefused(f"unknown fault control input: {', '.join(names)}")
    directory = Path(environment[CONTROL])
    if not directory.is_absolute() or not directory.is_dir():
        raise FaultPointsRefused(f"{CONTROL} is not an existing absolute directory")
    armed_file = directory / ARMED_FILE
    rows = json.loads(armed_file.read_text(encoding="utf-8")) if armed_file.exists() else []
    if not isinstance(rows, list):
        raise FaultPointsRefused(f"{ARMED_FILE} is not a list of armed points")
    for row in rows:
        point = row.get("point") if isinstance(row, dict) else None
        mode = row.get("mode") if isinstance(row, dict) else None
        spec = POINTS.get(str(point))
        if spec is None:
            raise FaultPointsRefused(f"{point!r} is not a Core fault point")
        if mode not in CONTROL_MODES or spec.mode != "crash":
            raise FaultPointsRefused(
                f"{point} is armed from outside only as a crash point, in mode crash or kill"
            )
        with _lock:
            if spec.site in _armed:
                raise FaultPointsRefused(
                    f"site {spec.site} is already armed, by {_armed[spec.site].point}"
                )
            _armed[spec.site] = _Armed(str(point), str(mode), None, control=directory)
    return directory


def arm(point: str, *, hold: Barrier | None = None) -> None:
    """Arm `point`: a crash point takes no barrier, a hold point needs one."""
    _require_permitted()
    spec = POINTS.get(point)
    if spec is None:
        raise FaultPointsRefused(f"{point!r} is not a Core fault point")
    if spec.mode == "hold" and hold is None:
        raise FaultPointsRefused(f"{point} holds, so it needs a barrier")
    if spec.mode == "crash" and hold is not None:
        raise FaultPointsRefused(f"{point} crashes, so it takes no barrier")
    with _lock:
        if spec.site in _armed:
            raise FaultPointsRefused(
                f"site {spec.site} is already armed, by {_armed[spec.site].point}"
            )
        _armed[spec.site] = _Armed(point, spec.mode, hold)


def hits(point: str) -> int:
    """How many times the armed `point` has been reached; 0 when it is not armed."""
    spec = POINTS.get(point)
    if spec is None:
        return 0
    with _lock:
        entry = _armed.get(spec.site)
        return entry.hits if entry is not None and entry.point == point else 0


def disarm(point: str) -> int:
    """Disarm `point` and return how many times it was reached; 0 when it was not armed."""
    spec = POINTS.get(point)
    if spec is None:
        return 0
    with _lock:
        entry = _armed.get(spec.site)
        if entry is None or entry.point != point:
            return 0
        del _armed[spec.site]
        return entry.hits


def armed_points() -> tuple[str, ...]:
    """The points armed now."""
    with _lock:
        return tuple(sorted(entry.point for entry in _armed.values()))


def disarm_all() -> None:
    with _lock:
        _armed.clear()
