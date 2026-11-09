"""Offline qualification of the temporary G1 expected-red gate."""

import json
import tomllib
from pathlib import Path

from dev.check_first_slice_expected_red import EXPECTED_STATES, audit, load, main, report
from dev.mutate_first_slice_expected_red import COPIED_FILES, MUTATIONS

ROOT = Path(__file__).resolve().parents[1]
INVENTORY = ROOT / "tests/first_slice/scenarios.toml"
RAW = INVENTORY.read_text(encoding="utf-8")


def changed(old: str, new: str):
    assert RAW.count(old) == 1, f"mutation anchor is not unique: {old!r}"
    return tomllib.loads(RAW.replace(old, new))


def test_current_registry_is_the_reviewed_expected_red_boundary():
    data = load(INVENTORY)
    assert audit(data) == []
    assert report(data)["states"] == EXPECTED_STATES
    assert report(data)["runtime_acceptance"] == "not_met"


def test_wrong_required_count_is_refused():
    assert audit(changed("required_count = 33", "required_count = 32")) == [
        "required_count must be 33"
    ]


def test_a_passing_scenario_is_refused():
    problems = audit(
        changed(
            'id = "FS-BOOT-01"\ngroup = "R01 bootstrap and authority"\nstate = "xfail"',
            'id = "FS-BOOT-01"\ngroup = "R01 bootstrap and authority"\nstate = "pass"',
        )
    )
    assert problems == [
        "state counts must be {'pass': 0, 'xfail': 32, 'blocked': 1}; observed "
        "{'pass': 1, 'xfail': 31, 'blocked': 1}"
    ]


def test_a_decision_boundary_change_is_refused():
    assert audit(
        changed(
            'source = "docs/adr/0019-organisation-lifecycle-states.md; docs/specs/FIRST_SLICE_G1.md"\nstatus = "decided"',
            'source = "docs/adr/0019-organisation-lifecycle-states.md; docs/specs/FIRST_SLICE_G1.md"\nstatus = "open"',
        )
    ) == ["decision statuses differ from the G1 decision boundary"]


def test_a_blocker_reassigned_to_another_open_decision_is_refused():
    assert audit(
        changed(
            'id = "FS-LIFE-03"\ngroup = "R02 and R07 lifetimes and coherent identifiers"\nstate = "blocked"\ngap = "decision:post-identity-erasure-one-time-redelivery"',
            'id = "FS-LIFE-03"\ngroup = "R02 and R07 lifetimes and coherent identifiers"\nstate = "blocked"\ngap = "decision:invoice-issuer-and-reconciliation"',
        )
    ) == ["blocked scenarios differ from the owner-gated lifecycle scenario"]


def test_cli_make_and_mutation_manifest_are_wired(capsys):
    assert main(["--inventory", str(INVENTORY)]) == 0
    assert json.loads(capsys.readouterr().out)["runtime_acceptance"] == "not_met"

    makefile = (ROOT / "Makefile").read_text(encoding="utf-8")
    assert "check-first-slice-expected-red:" in makefile
    assert "python dev/check_first_slice_expected_red.py" in makefile
    assert "mutate-first-slice-expected-red:" in makefile
    assert "python dev/mutate_first_slice_expected_red.py" in makefile

    assert "dev/mutate_first_slice_expected_red.py" in COPIED_FILES
    assert "tests/test_first_slice_expected_red.py" in COPIED_FILES
    assert "dev/check_first_slice_expected_red.py" in COPIED_FILES

    checker = (ROOT / "dev/check_first_slice_expected_red.py").read_text(encoding="utf-8")
    tests = Path(__file__).read_text(encoding="utf-8")
    for name, old, _new, target, expected in MUTATIONS:
        assert checker.count(old) == 1, name
        assert f"def {target}(" in tests, name
        assert expected in tests, name
