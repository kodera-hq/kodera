"""Direct refusal and selected-profile proofs for the queue's test-only controls.

This is a configuration boundary, not a sandbox against arbitrary Python that replaces the guard
or rewrites both Django's selector and settings. Child fixtures must load successfully; only the
exact permission refusal counts as proof.
"""

from __future__ import annotations

import importlib
import re
from pathlib import Path
from typing import Any

import pytest
from django.test.utils import override_settings
from test_job_queue_flags_refused import _child

from apps.jobs import mutants

REFUSAL = "job-queue mutant flags are refused: these settings do not permit them"
TEST_PROFILE = "config.settings.test"
CHILD = """
import json
import os
from django.conf import settings
from apps.jobs import mutants

# Force successful settings loading before attempting any controls.
loaded_module = settings.SETTINGS_MODULE
loaded_permission = getattr(settings, "JOB_QUEUE_MUTANTS_PERMITTED", False) is True
# ASSIGNMENTS
# MUTATION

def observe(call):
    try:
        return {"returned": call()}
    except mutants.MutantsRefused as error:
        return {"refused": str(error)}

active = observe(lambda: sorted(mutants.active()))
activation = observe(lambda: mutants.activate("no_dedupe"))
mutants.deactivate()
print(json.dumps({"loaded": loaded_module, "permission": loaded_permission,
                  "active": active, "activation": activation}))
"""
FLAG = 'settings.JOB_QUEUE_MUTANTS = frozenset({"no_dedupe"})'
SPOOF = (
    'settings.SETTINGS_MODULE = "config.settings.test"\n'
    "settings.JOB_QUEUE_MUTANTS_PERMITTED = True\n" + FLAG
)


def _report(
    profile: str,
    assignments: str = FLAG,
    *,
    extra_path: Path | None = None,
    inputs: dict[str, str] | None = None,
    mutation: str = "",
) -> dict[str, Any]:
    script = CHILD.replace("# ASSIGNMENTS", assignments).replace("# MUTATION", mutation)
    result = _child(script, profile, extra_path, inputs or {})
    assert isinstance(result, dict)
    return result


def _assert_refused(report: dict[str, Any]) -> None:
    assert report["active"] == {"refused": REFUSAL}, "non-permitted flags became active"
    assert report["activation"] == {"refused": REFUSAL}, "non-permitted activation succeeded"


def test_custom_profiles_cannot_enable_queue_controls(tmp_path: Path) -> None:
    sources = {
        "external_flags.py": 'SETTINGS_MODULE = "config.settings.test"\nJOB_QUEUE_MUTANTS_PERMITTED = True\n',
        "copied.py": "from config.settings.test import *\n",
        "external.py": "from config.settings.job_queue import *\nfrom external_flags import *\n",
        "package/__init__.py": "from config.settings.job_queue import *\nfrom external_flags import *\n",
        "package/nested/__init__.py": "",
        "package/nested/test.py": "from config.settings.job_queue import *\nfrom ..external_flags import *\n",
        "package/external_flags.py": "from external_flags import *\n",
        "conditional.py": (
            "import os\nfrom config.settings.job_queue import *\n"
            "JOB_QUEUE_MUTANTS_PERMITTED = os.environ.get('CONTROL_A') == '1' and "
            "os.environ.get('CONTROL_B') == '1'\n"
        ),
        "function_import.py": (
            "from config.settings.job_queue import *\n"
            "def permission():\n    from external_flags import JOB_QUEUE_MUTANTS_PERMITTED\n"
            "    return JOB_QUEUE_MUTANTS_PERMITTED\nJOB_QUEUE_MUTANTS_PERMITTED = permission()\n"
        ),
    }
    for name, source in sources.items():
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source, encoding="utf-8")
    for profile in (
        "copied",
        "external",
        "package",
        "package.nested.test",
        "conditional",
        "function_import",
    ):
        report = _report(profile, extra_path=tmp_path, inputs={"CONTROL_A": "1", "CONTROL_B": "1"})
        assert report["permission"] is True, "the custom settings fixture did not supply permission"
        _assert_refused(report)


def test_direct_settings_assignment_cannot_spoof_the_test_profile() -> None:
    report = _report("config.settings.job_queue", SPOOF)
    assert report["loaded"] == "config.settings.job_queue"
    _assert_refused(report)


def test_test_profile_permission_requires_true_and_matching_identity() -> None:
    assignments = (
        "settings.JOB_QUEUE_MUTANTS_PERMITTED = False",
        "settings.JOB_QUEUE_MUTANTS_PERMITTED = 1",
        'settings.JOB_QUEUE_MUTANTS_PERMITTED = "true"',
        "del settings.JOB_QUEUE_MUTANTS_PERMITTED",
        'settings.SETTINGS_MODULE = "config.settings.job_queue"',
        "settings.SETTINGS_MODULE = None",
        "del settings.SETTINGS_MODULE",
        'os.environ.pop("DJANGO_SETTINGS_MODULE")',
    )
    for assignment in assignments:
        _assert_refused(_report(TEST_PROFILE, FLAG + "\n" + assignment))

    manual = CHILD.replace(
        "# Force successful settings loading before attempting any controls.",
        'settings.configure(SETTINGS_MODULE="config.settings.test", '
        'JOB_QUEUE_MUTANTS_PERMITTED=True, JOB_QUEUE_MUTANTS=frozenset({"no_dedupe"}))',
    )
    report = _child(manual, TEST_PROFILE, None, {})
    assert isinstance(report, dict)
    _assert_refused(report)


def test_actual_test_profile_allows_overrides_and_revokes_permission() -> None:
    script = """
import json
from django.conf import settings
from django.test.utils import override_settings
from apps.jobs import mutants

assert settings.SETTINGS_MODULE == "config.settings.test"
assert mutants.active() == frozenset()
mutants.activate("no_dedupe")
try:
    assert mutants.on("no_dedupe")
    with override_settings(JOB_QUEUE_MUTANTS=frozenset({"any_role"})):
        assert mutants.active() == frozenset({"any_role"})
        with override_settings(JOB_QUEUE_MUTANTS_PERMITTED=False):
            try:
                mutants.active()
            except mutants.MutantsRefused as error:
                refusal = str(error)
            else:
                raise AssertionError("nested permission revocation was ignored")
    assert mutants.active() == frozenset({"no_dedupe"})
    with override_settings(SETTINGS_MODULE="config.settings.test"):
        assert mutants.active() == frozenset({"no_dedupe"})
    with override_settings(SETTINGS_MODULE="config.settings.test"):
        del settings.SETTINGS_MODULE
        try:
            mutants.active()
        except mutants.MutantsRefused as error:
            assert str(error) == refusal
        else:
            raise AssertionError("a deleted wrapper profile was ignored")
    for module in ("other", None):
        with override_settings(SETTINGS_MODULE=module):
            try:
                mutants.active()
            except mutants.MutantsRefused as error:
                assert str(error) == refusal
            else:
                raise AssertionError("an explicit profile override was ignored")
finally:
    mutants.deactivate()
assert mutants.active() == frozenset()
print(json.dumps(refusal))
"""
    assert _child(script, TEST_PROFILE, None, {}) == REFUSAL


def test_control_proof_rejects_each_permission_weakening() -> None:
    selected = 'os.environ.get("DJANGO_SETTINGS_MODULE") == "config.settings.test"'
    effective = 'getattr(settings, "SETTINGS_MODULE", None) == "config.settings.test"'
    permitted = 'getattr(settings, "JOB_QUEUE_MUTANTS_PERMITTED", False) is True'
    cases = (
        ("config.settings.job_queue", SPOOF, f"{effective} and {permitted}"),
        (
            TEST_PROFILE,
            FLAG + '\nsettings.SETTINGS_MODULE = "other"',
            f"{selected} and {permitted}",
        ),
        (
            TEST_PROFILE,
            FLAG + "\nsettings.JOB_QUEUE_MUTANTS_PERMITTED = False",
            f"{selected} and {effective}",
        ),
        (
            TEST_PROFILE,
            FLAG + "\nsettings.JOB_QUEUE_MUTANTS_PERMITTED = 1",
            f'{selected} and {effective} and getattr(settings, "JOB_QUEUE_MUTANTS_PERMITTED", False)',
        ),
    )
    for profile, assignments, condition in cases:
        mutation = (
            "def weakened_permission():\n"
            f"    if not ({condition}):\n        raise mutants.MutantsRefused({REFUSAL!r})\n"
            "mutants._require_permitted = weakened_permission"
        )
        report = _report(profile, assignments, mutation=mutation)
        with pytest.raises(AssertionError, match="non-permitted flags became active"):
            _assert_refused(report)

    manual = CHILD.replace(
        "# Force successful settings loading before attempting any controls.",
        'settings.configure(SETTINGS_MODULE="config.settings.test", '
        'JOB_QUEUE_MUTANTS_PERMITTED=True, JOB_QUEUE_MUTANTS=frozenset({"no_dedupe"}))',
    ).replace("# MUTATION", "mutants._settings_profile = lambda: settings.SETTINGS_MODULE")
    manual_report = _child(manual, TEST_PROFILE, None, {})
    assert isinstance(manual_report, dict)
    with pytest.raises(AssertionError, match="non-permitted flags became active"):
        _assert_refused(manual_report)


def test_runtime_controls_refuse_invalid_flags_and_concurrent_activation() -> None:
    with pytest.raises(
        ValueError, match=re.escape("'unknown_flag' is not a job-queue mutant flag")
    ):
        mutants.on("unknown_flag")
    with override_settings(JOB_QUEUE_MUTANTS=["no_dedupe"]):
        with pytest.raises(mutants.MutantsRefused) as malformed:
            mutants.active()
        assert (
            str(malformed.value)
            == "JOB_QUEUE_MUTANTS must be a frozenset of job-queue mutant flags"
        )
    with override_settings(JOB_QUEUE_MUTANTS=frozenset({"unknown_flag"})):
        with pytest.raises(mutants.MutantsRefused) as unknown:
            mutants.active()
        assert str(unknown.value) == "not job-queue mutant flags: unknown_flag"
    with pytest.raises(
        ValueError, match=re.escape("'unknown_flag' is not a job-queue mutant flag")
    ):
        mutants.activate("unknown_flag")
    assert mutants.active() == frozenset()
    try:
        mutants.activate("no_dedupe")
        mutants.activate("no_dedupe")
        with pytest.raises(mutants.MutantsRefused) as second:
            mutants.activate("any_role")
        assert str(second.value) == "no_dedupe is still active: deactivate it before any_role"
        assert mutants.active() == frozenset({"no_dedupe"})
    finally:
        mutants.deactivate()
    assert mutants.active() == frozenset()


class RecordingCursor:
    """Only guard reads are allowed before the invalid mutation is refused."""

    def __init__(self) -> None:
        self.statements: list[str] = []

    def execute(self, statement: str, parameters: object = None) -> None:
        self.statements.append(statement)
        assert statement.startswith("SELECT "), "a refused control attempted a database write"

    def fetchall(self) -> list[Any]:
        return []

    def fetchone(self) -> tuple[str]:
        return ("/*guard:missing_marker*/ true",)


def _database_helpers(monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.syspath_prepend(str(Path(__file__).parent / "job_queue"))
    return importlib.import_module("database_mutants")


def test_database_controls_refuse_foreign_snapshots_and_unknown_mutants(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = _database_helpers(monkeypatch)
    cursor = RecordingCursor()
    with pytest.raises(mutants.MutantsRefused) as foreign:
        database.restore_database(cursor, {})
    assert str(foreign.value) == "the snapshot does not name the job-queue guards"
    before = list(cursor.statements)
    with pytest.raises(ValueError, match=re.escape("'unknown_flag' is not a database mutant flag")):
        database.install_database_mutant(cursor, "unknown_flag")
    assert cursor.statements == before, "an unknown database flag read or wrote guards"
    with pytest.raises(mutants.MutantsRefused) as moved:
        database.apply_marker(cursor, database.Marker("synthetic_guard", count=2), "missing_marker")
    assert str(moved.value) == "missing_marker occurs 1 times in synthetic_guard, not 2"
    with pytest.raises(mutants.MutantsRefused) as absent:
        database.apply_marker(cursor, database.Marker("synthetic_guard"), "absent_marker")
    assert str(absent.value) == "absent_marker occurs 0 times in synthetic_guard, not 1"
    with override_settings(JOB_QUEUE_MUTANTS_PERMITTED=False):
        before = list(cursor.statements)
        for operation in (
            lambda: database.install_database_mutant(cursor, "freeze_skips_category"),
            lambda: database.restore_database(cursor, {}),
            lambda: database.apply_marker(
                cursor, database.Marker("synthetic_guard"), "absent_marker"
            ),
        ):
            with pytest.raises(mutants.MutantsRefused, match=re.escape(REFUSAL)):
                operation()
        assert cursor.statements == before, "a non-permitted database control reached the database"


def test_pristine_guard_comparison_reports_missing_and_disarmed_guards(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = _database_helpers(monkeypatch)
    snapshot = {f"function {name}": "armed" for name in database.GUARD_FUNCTIONS}
    snapshot.update(
        {
            f"constraint {table}.{name}": value
            for (table, name), value in database.PRISTINE_CONSTRAINTS.items()
        }
    )
    assert database.pristine_differences(snapshot) == []
    name = database.GUARD_FUNCTIONS[0]
    snapshot[f"function {name}"] = "/*guard:synthetic*/ false"
    assert database.pristine_differences(snapshot) == [f"{name} has a disarmed guard marker"]
    snapshot[f"function {name}"] = ""
    assert database.pristine_differences(snapshot) == [f"{name} is missing"]
