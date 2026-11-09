"""The worker boundary acceptance harness: the inventory, its binding, the gap probe and the checks.

Each WK test carries `@acceptance("WK-nn")`. A `pass` row runs plainly. An `xfail` row runs under a
strict expected failure whose only accepted outcome is `WorkerGapError` for the row's gap, raised by
`require()` and still missing when measured again: a pass, another gap, a forged gap or any other
failure fails the run. The checks below return the reasons a configuration breaks the boundary, each
one sentence, so the self-test can prove each one fails by its message.

No Docker: processes are started with fixed synthetic inputs, compose is read as YAML, and images
are read through dev/image_context.py. WK-11 to WK-13 use the test database (worker_harness.py).
"""

from __future__ import annotations

import functools
import json
import os
import re
import subprocess
import sys
import tomllib
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

import pytest

from dev.image_context import image_files
from dev.worker_boundary import (
    NETWORK as NETWORK,
    api_image_worker_refusals as api_image_worker_refusals,
    runner_missing as runner_missing,
    worker_image_refusals as worker_image_refusals,
    worker_network_refusals as worker_network_refusals,
)

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
INVENTORY_PATH = HERE / "acceptance.toml"
ID_PATTERN = re.compile(r"WK-[0-9]{2}\Z")
GAPS = ("worker:runner", "worker:synthetic-provider-proof")
STATES = ("pass", "xfail")
WORKER_SETTINGS = "config.settings.deploy_worker"
WORKER_DOCKERFILE = "Dockerfile.worker"

# The synthetic inputs a worker process is started with: a database URL and nothing secret.
WORKER_INPUTS = {"DATABASE_URL": "postgresql://synthetic:synthetic-pass@db.synthetic.test/core"}


class InventoryError(ValueError):
    pass


class WorkerGapError(Exception):
    """The first thing a WK test reached that this tree does not have. Raised by `require` only."""

    def __init__(self, gap: str, detail: str) -> None:
        super().__init__(f"{gap}: {detail}")
        self.gap = gap


# ----------------------------------------------------------------------------- inventory ----


def load_inventory(text: str) -> dict[str, dict[str, Any]]:
    """The inventory, refused whole if any row is malformed."""
    data = tomllib.loads(text)
    if data.get("format") != 1:
        raise InventoryError("format must be 1")
    rows: dict[str, dict[str, Any]] = {}
    for row in data.get("test", []):
        identifier = row.get("id")
        if not isinstance(identifier, str) or ID_PATTERN.fullmatch(identifier) is None:
            raise InventoryError(f"malformed identifier {identifier!r}")
        if identifier in rows:
            raise InventoryError(f"{identifier} appears twice")
        if row.get("state") not in STATES:
            raise InventoryError(f"{identifier} has state {row.get('state')!r}")
        gap = row.get("gap")
        if row["state"] == "xfail" and gap not in GAPS:
            raise InventoryError(f"{identifier} is xfail with no known gap")
        if row["state"] == "pass" and gap is not None:
            raise InventoryError(f"{identifier} passes and still records gap {gap!r}")
        expected = "test_" + identifier.lower().replace("-", "_") + "_"
        if not str(row.get("function", "")).startswith(expected):
            raise InventoryError(f"{identifier} names no function starting {expected}")
        rows[identifier] = row
    if not rows:
        raise InventoryError("the inventory has no test")
    return rows


INVENTORY = load_inventory(INVENTORY_PATH.read_text(encoding="utf-8"))


# Restart policies that bring a crashed worker back; "no", or none at all, leaves it down.
RESTARTING = ("always", "unless-stopped", "on-failure")


def worker_supervision_refusals(compose: Mapping[str, Any]) -> list[str]:
    """Why compose would leave a crashed worker down, or its exited processes unreaped, or []:
    the runner is crash-only (worker/runner.py) and reaps no escaped grandchild of its steps."""
    worker = (compose.get("services") or {}).get("worker") or {}
    refusals = []
    if str(worker.get("restart", "no")).split(":", 1)[0] not in RESTARTING:
        refusals.append("the worker has no restart policy to bring a crash-only runner back")
    if worker.get("init") is not True:
        refusals.append("the worker runs without an init to reap its exited processes")
    return refusals


# ------------------------------------------------------------------------------- the gaps ----


def _provider_proof_missing() -> bool:
    """True while the synthetic provider cannot authenticate a terminal proof of its own."""
    from worker.providers import synthetic

    try:
        provider = synthetic.SyntheticProvider(key=bytes(synthetic.KEY_BYTES), directory=HERE)
        proof = provider.terminal_proof(dispatch_id="d", operation_ref="o", outcome="succeeded")
    except (TypeError, AttributeError):
        return True
    return not provider.verify(proof)


def gap_is_missing(gap: str) -> bool:
    """Measure the gap again: True while what it names does not exist."""
    if gap == "worker:runner":
        return runner_missing()
    if gap == "worker:synthetic-provider-proof":
        return _provider_proof_missing()
    raise AssertionError(f"unknown worker gap {gap}")


def require(gap: str) -> None:
    """Raise the gap while what it names is missing; fail the moment it appears."""
    if gap_is_missing(gap):
        raise WorkerGapError(gap, "not built")
    raise AssertionError(
        f"{gap} now exists: bind the WK rows recorded at {gap} to it before trusting the gap"
    )


def acceptance(identifier: str) -> Callable[[Callable[..., None]], Callable[..., None]]:
    """Bind a test to its inventory row."""
    row = INVENTORY[identifier]

    def bind(test: Callable[..., None]) -> Callable[..., None]:
        if test.__name__ != row["function"]:
            raise InventoryError(f"{identifier} names {row['function']}, not {test.__name__}")
        if row["state"] == "pass":
            return test

        @functools.wraps(test)
        def expected_gap(*args: Any, **kwargs: Any) -> None:
            try:
                test(*args, **kwargs)
            except WorkerGapError as reached:
                if reached.gap != row["gap"]:
                    raise AssertionError(
                        f"{identifier} stopped at {reached.gap}, its row records {row['gap']}"
                    ) from None
                if not gap_is_missing(reached.gap):
                    raise AssertionError(
                        f"{identifier} raised {reached.gap}, which is no longer missing"
                    ) from None
                raise

        marked: Callable[..., None] = pytest.mark.xfail(
            strict=True, raises=WorkerGapError, reason=row["gap"]
        )(expected_gap)
        return marked

    return bind


# --------------------------------------------------------------------------- processes ----


def worker_process(
    *arguments: str,
    environment: Mapping[str, str] | None = None,
    program: str | None = None,
    cwd: Path = ROOT,
) -> subprocess.CompletedProcess[str]:
    """`python -m worker <arguments>`, or `python -c <program>`, with fixed synthetic inputs."""
    command = [sys.executable, "-B", "-c", program] if program else [sys.executable, "-B", "-m"]
    if not program:
        command += ["worker", *arguments]
    return subprocess.run(  # noqa: S603 - a fixed interpreter and owned programs
        command,
        cwd=cwd,
        env={
            "PATH": os.environ.get("PATH", os.defpath),
            "PYTHONPATH": str(cwd),
            "PYTHONDONTWRITEBYTECODE": "1",
            **WORKER_INPUTS,
            **(environment or {}),
        },
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )


def last_line(result: subprocess.CompletedProcess[str]) -> str:
    lines = (result.stderr or result.stdout).strip().splitlines()
    return lines[-1] if lines else ""


def check_report(result: subprocess.CompletedProcess[str]) -> dict[str, Any]:
    assert result.returncode == 0, result.stderr[-2000:]
    report: dict[str, Any] = json.loads(result.stdout.strip().splitlines()[-1])
    return report


def worker_image_files(root: Path = ROOT) -> list[str]:
    return image_files(root, WORKER_DOCKERFILE)
