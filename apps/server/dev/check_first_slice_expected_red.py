#!/usr/bin/env python3
"""Refuse drift from the reviewed G1 expected-red first-slice inventory.

This is an interim planning gate, not product acceptance. The runtime acceptance command remains
``make first-slice-scenarios`` and stays nonzero until every mandatory scenario passes.
"""

from __future__ import annotations

import argparse
import json
import sys
import tomllib
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INVENTORY = ROOT / "tests/first_slice/scenarios.toml"

EXPECTED_IDS = tuple(
    f"FS-{group}-{number:02}"
    for group, count in (
        ("BOOT", 7),
        ("LIFE", 3),
        ("ID", 3),
        ("OP", 6),
        ("CON", 6),
        ("BILL", 6),
        ("JOURNEY", 1),
        ("HARNESS", 1),
    )
    for number in range(1, count + 1)
)
EXPECTED_COUNT = 33
EXPECTED_STATES = {"pass": 0, "xfail": 32, "blocked": 1}
EXPECTED_DECISIONS = {
    "organisation-states-and-wire-operations": "decided",
    "mfa-contact-proof-and-claim-delivery": "decided",
    "tenant-scoped-retained-access-window": "decided",
    "post-identity-erasure-one-time-redelivery": "open",
    "operation-scope-and-dedup-retention": "decided",
    "invoice-issuer-and-reconciliation": "open",
    "external-execution-stop-evidence": "decided",
    "place-order-staff-operator-and-dpa-acceptance": "decided",
}
EXPECTED_BLOCKED = {
    "FS-LIFE-03": "decision:post-identity-erasure-one-time-redelivery",
}


def audit(data: dict[str, Any]) -> list[str]:
    """Return every G1 inventory disagreement in stable order."""
    problems: list[str] = []
    if data.get("format") != 1:
        problems.append("format must be 1")
    if data.get("required_count") != EXPECTED_COUNT:
        problems.append(f"required_count must be {EXPECTED_COUNT}")

    rows = data.get("scenario")
    if not isinstance(rows, list):
        return [*problems, "scenario must be a list"]
    ids = tuple(row.get("id") for row in rows if isinstance(row, dict))
    if ids != EXPECTED_IDS:
        problems.append("scenario identifiers or order differ from the 33-scenario contract")

    state_counts: Counter[str] = Counter()
    for row in rows:
        if not isinstance(row, dict):
            continue
        state = row.get("state")
        if isinstance(state, str):
            state_counts[state] += 1
    actual_states = {state: state_counts.get(state, 0) for state in EXPECTED_STATES}
    unknown_states = sorted(set(state_counts) - set(EXPECTED_STATES))
    if actual_states != EXPECTED_STATES or unknown_states:
        problems.append(
            f"state counts must be {EXPECTED_STATES}; observed {actual_states}"
            + (f" with unknown states {unknown_states}" if unknown_states else "")
        )

    decisions = data.get("decision")
    if isinstance(decisions, dict):
        decision_statuses = {
            key: value.get("status") if isinstance(value, dict) else None
            for key, value in decisions.items()
        }
    else:
        decision_statuses = {}
    if decision_statuses != EXPECTED_DECISIONS:
        problems.append("decision statuses differ from the G1 decision boundary")

    blocked = {
        str(row.get("id")): str(row.get("gap"))
        for row in rows
        if isinstance(row, dict) and row.get("state") == "blocked"
    }
    if blocked != EXPECTED_BLOCKED:
        problems.append("blocked scenarios differ from the owner-gated lifecycle scenario")
    return problems


def load(path: Path) -> dict[str, Any]:
    with path.open("rb") as handle:
        value = tomllib.load(handle)
    if not isinstance(value, dict):
        raise ValueError("inventory root must be a table")
    return value


def report(data: dict[str, Any]) -> dict[str, Any]:
    decisions = data["decision"]
    return {
        "format": 1,
        "status": "expected_red",
        "scenarios": EXPECTED_COUNT,
        "states": EXPECTED_STATES,
        "open_decisions": [key for key, value in decisions.items() if value["status"] == "open"],
        "decided_decisions": [
            key for key, value in decisions.items() if value["status"] == "decided"
        ],
        "runtime_acceptance": "not_met",
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path, default=DEFAULT_INVENTORY)
    arguments = parser.parse_args(argv)
    try:
        data = load(arguments.inventory)
        problems = audit(data)
    except (OSError, ValueError, tomllib.TOMLDecodeError) as error:
        problems = [f"inventory unreadable: {type(error).__name__}"]
        data = {}
    if problems:
        print(json.dumps({"format": 1, "status": "refused", "problems": problems}, indent=2))
        return 1
    print(json.dumps(report(data), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
