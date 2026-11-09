"""The fault-point inventory holds against the tree, and the harness arms its points honestly.

`test_the_tree_matches_the_fault_point_inventory` is the check most mutants of
dev/mutate_first_slice_fault_points.py must turn red by its own message; the next two prove it
reads something, so it cannot pass by seeing nothing. The harness's `fault_point` and `race` are
driven here without a database or the first-slice admission, so CI's mutation proofs can run them.
"""

import sys
from pathlib import Path

import pytest

from core import faults
from dev.check_first_slice_fault_points import (
    ROOT,
    audit,
    load_inventory,
    planned_matches,
    reaches,
    scenario_uses,
)

sys.path.insert(0, str(Path(__file__).resolve().parent / "first_slice"))

from first_slice_harness import (  # noqa: E402 - the harness directory is set above
    BARRIER_SECONDS,
    INVENTORY_PATH,
    FirstSliceHarness,
    MissingBehaviourError,
    load_inventory as load_scenarios,  # noqa: E402
)

INVENTORY = load_inventory(ROOT / "tests/first_slice/fault_points.toml")


@pytest.fixture
def harness(request, settings):
    """The harness without its database, clock or admission: only its fault-point seams."""
    built = FirstSliceHarness(
        request=request,
        settings=settings,
        inventory=load_scenarios(INVENTORY_PATH.read_text(encoding="utf-8")),
    )
    yield built
    faults.disarm_all()


def test_the_tree_matches_the_fault_point_inventory():
    problems = audit(ROOT)
    assert not problems, "\n".join(problems)


def test_the_check_reads_every_site_and_every_scenario_use():
    sites = {row["name"]: row for row in INVENTORY["site"]}
    found, problems = reaches(ROOT, {name: row["follows"] for name, row in sites.items()})
    assert problems == []
    assert sorted(reach.site or "" for reach in found) == sorted(sites), (
        "the check did not find one reach() per site, so it could pass by seeing none"
    )
    uses, problems = scenario_uses(ROOT)
    assert problems == []
    recorded = [row["name"] for key in ("point", "planned") for row in INVENTORY[key]]
    assert sorted(uses) == sorted(recorded), "the check missed a name a scenario arms"


def test_a_planned_name_matches_only_one_filled_segment():
    assert planned_matches(
        "provision:*:after-clients-created", "provision:t-1:after-clients-created"
    )
    assert not planned_matches(
        "provision:*:after-clients-created", "provision::after-clients-created"
    )
    assert not planned_matches(
        "provision:*:after-clients-created", "provision:a:b:after-clients-created"
    )
    assert not planned_matches("worker:provider-response-lost", "worker:provider-response-lost:x")


# ------------------------------------------------------------------- the harness's seams ----


def test_an_unrecorded_fault_point_name_is_an_assertion_and_a_planned_one_is_the_gap(harness):
    with pytest.raises(AssertionError, match="is not a fault point fault_points.toml records"):
        with harness.fault_point("intake:nowhere"):
            pass
    with pytest.raises(MissingBehaviourError) as planned:
        with harness.fault_point("provision:tenant-1:after-clients-created"):
            pass
    assert planned.value.gap == "harness:core-fault-points"


def test_a_crash_point_swallows_only_its_own_crash_and_must_be_reached(harness):
    with harness.fault_point("intake:after-job"):
        faults.reach("intake:after-job")
    assert faults.armed_points() == ()
    with pytest.raises(AssertionError, match="intake:after-job was armed and never reached"):
        with harness.fault_point("intake:after-job"):
            pass
    with pytest.raises(AssertionError, match="its crash never left Core"):
        with harness.fault_point("intake:after-job"):
            try:
                faults.reach("intake:after-job")
            except BaseException:  # noqa: BLE001, S110 - the weakening under test
                pass
    with pytest.raises(MissingBehaviourError):
        with harness.fault_point("intake:after-job"):
            raise MissingBehaviourError("harness:identity-provider-second-factor", "a gap first")
    assert faults.armed_points() == (), "a gap raised in the body left the point armed"


def test_a_held_point_is_released_once_every_other_racer_has_returned(harness):
    order = []

    def held():
        faults.reach("intake:before-commit")
        order.append("held")
        return "held"

    def free():
        order.append("free")
        return "free"

    with harness.fault_point("intake:hold-before-commit") as hold:
        assert harness.race(held, free, free) == ["held", "free", "free"]
    assert hold is not None and hold.reached.is_set() and hold.released.is_set()
    assert order == ["free", "free", "held"], "the hold was released before the other racers"


def test_a_hold_that_times_out_fails_the_scenario(harness, monkeypatch):
    """A held site never released crashes out of Core; the harness must not count that as the
    hold having served, or FS-OP-01 would pass with its assertions skipped."""
    monkeypatch.setattr(faults, "HOLD_SECONDS", 0.05)
    message = None
    try:
        with harness.fault_point("intake:hold-before-commit"):
            faults.reach("intake:before-commit")
    except AssertionError as error:
        message = str(error)
    assert message == "hold intake:hold-before-commit timed out", (
        f"a timed-out hold was swallowed: {message}"
    )


def test_a_hold_outlasts_the_harness_release_deadline():
    assert faults.HOLD_SECONDS > BARRIER_SECONDS * 3, (
        "a hold can time out before the harness's own deadline releases it"
    )


# ------------------------------------------------------------- what the check refuses ----


def _tree(tmp_path, relative, source):
    path = tmp_path / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(source, encoding="utf-8")
    return tmp_path


@pytest.mark.parametrize(
    ("source", "message"),
    [
        (
            "from core import faults as f\n",
            "apps/x.py:1 imports core.faults other than as `from core import faults`",
        ),
        (
            "import core.faults\ncore.faults.reach('intake:after-job')\n",
            "apps/x.py:1 imports core.faults other than as `from core import faults`",
        ),
        (
            "import core.faults as cf\n",
            "apps/x.py:1 imports core.faults other than as `from core import faults`",
        ),
        (
            "import core\ncore.faults.reach('intake:after-job')\n",
            "apps/x.py:2 calls reach through core.faults, not faults.reach",
        ),
        (
            "from core import faults\nhit = faults.reach\n",
            "apps/x.py:2 refers to faults.reach other than by calling it",
        ),
        (
            "from core import faults\ngetattr(faults, 'reach')('intake:after-job')\n",
            "apps/x.py:2 looks reach up by name",
        ),
        (
            "from core import faults\nfaults.reach(site='intake:after-job')\n",
            "apps/x.py:2 calls faults.reach() with something other than one string literal",
        ),
        (
            "from core.faults import reach as hit\n",
            "apps/x.py:1 imports reach from core.faults; call it as faults.reach so the check "
            "can see the site",
        ),
    ],
)
def test_the_check_refuses_every_reach_it_cannot_see_as_a_site(tmp_path, source, message):
    _, problems = reaches(_tree(tmp_path, "apps/x.py", source), {})
    assert message in problems, problems


@pytest.mark.parametrize(
    ("source", "message"),
    [
        (
            "def helper(h):\n    with h.fault_point('intake:after-job'):\n        pass\n",
            "tests/first_slice/test_fs_x.py:2 arms a fault point outside a scenario",
        ),
        (
            "@scenario('FS-OP-01')\ndef test_x(harness):\n"
            "    with harness.fault_point(name='intake:after-job'):\n        pass\n",
            "tests/first_slice/test_fs_x.py:3 arms a fault point with arguments the check cannot "
            "read",
        ),
    ],
)
def test_the_check_refuses_a_fault_point_it_cannot_attribute(tmp_path, source, message):
    _, problems = scenario_uses(_tree(tmp_path, "tests/first_slice/test_fs_x.py", source))
    assert message in problems, problems


def test_the_sites_are_the_points_sites():
    assert faults.SITES == tuple(dict.fromkeys(point.site for point in faults.POINTS.values()))
