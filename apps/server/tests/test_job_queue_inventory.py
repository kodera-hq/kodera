"""The job-queue acceptance rows, counted from outside their directory.

`tests/job_queue/conftest.py` fails a run that visits the directory and leaves a row uncalled. It
cannot see a run that never reports a collector from inside the directory, because it is not loaded
then, or is loaded and told nothing: a `python_files` pattern or a rename that leaves the directory
with no test module, a `testpaths` or `norecursedirs` that leaves it out, an `--ignore` in `addopts`,
a `collect_ignore` in a `conftest.py` above it. Each of those is a tracked edit outside the
directory, and each would silence all thirty-one rows with an exit status of 0.

This module lives outside the directory, so such an edit does not silence it too. It imports nothing
from the directory: the inventory is read as TOML and the acceptance module as a syntax tree. It
reads the pytest configuration this repository carries, and refuses, each by its own sentence, a
configuration that would keep pytest from collecting the two test modules.

What it does not cover: an `--ignore`, an `--ignore-glob` or a `-p no:…` given on a command line or
in `PYTEST_ADDOPTS`, which no tracked file shows. CI's `Tests` job therefore counts, from outside
the directory, the rows that produced a call report in its JUnit report:
`scripts/ci/check-job-queue-rows.py` (`docs/specs/JOB_QUEUE.md` §9.1, §9.2).
"""

from __future__ import annotations

import ast
import fnmatch
import shlex
import tomllib
from pathlib import Path, PurePosixPath
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = PurePosixPath("tests/job_queue")
MODULES = ("test_job_queue_acceptance.py", "test_job_queue_selftest.py")
MARKER = "job_queue_acceptance"
EXPECTED = [f"A3-{number:02}" for number in range(1, 32)]
# Files that outrank or replace `pyproject.toml` as pytest's configuration.
RIVAL_CONFIGURATIONS = ("pytest.ini", ".pytest.ini", "tox.ini", "setup.cfg")
DEFAULT_PYTHON_FILES = ["test_*.py", "*_test.py"]
IGNORING_OPTIONS = ("--ignore", "--ignore-glob", "--deselect")


def marked_functions(source: str) -> dict[str, list[str]]:
    """Each acceptance identifier and the module-level test functions that carry it."""
    found: dict[str, list[str]] = {}
    for node in ast.parse(source).body:
        if not isinstance(node, ast.FunctionDef):
            continue
        for decorator in node.decorator_list:
            if (
                isinstance(decorator, ast.Call)
                and isinstance(decorator.func, ast.Name)
                and decorator.func.id == MARKER
                and len(decorator.args) == 1
                and isinstance(decorator.args[0], ast.Constant)
            ):
                found.setdefault(str(decorator.args[0].value), []).append(node.name)
    return found


def _values(options: list[str]) -> list[tuple[str, str]]:
    """The `--option value` and `--option=value` pairs among command-line words."""
    pairs = []
    for index, word in enumerate(options):
        name, separator, value = word.partition("=")
        if name not in IGNORING_OPTIONS:
            continue
        if not separator:
            value = options[index + 1] if index + 1 < len(options) else ""
        pairs.append((name, value))
    return pairs


def _touches(pattern: str) -> bool:
    """Whether a path or a glob names the directory, something above it, or a module inside it."""
    target = pattern.split("::", 1)[0].rstrip("/")
    paths = [DIRECTORY, *DIRECTORY.parents, *(DIRECTORY / module for module in MODULES)]
    candidates = [str(path) for path in paths if str(path) != "."]
    candidates += [str(ROOT / candidate) for candidate in candidates]
    candidates += [part for part in DIRECTORY.parts] + list(MODULES)
    return any(fnmatch.fnmatch(candidate, target) for candidate in candidates)


def _ignored_by(source: str) -> list[str]:
    """What a `conftest.py` above the directory does that can keep pytest out of it."""
    found = []
    for node in ast.parse(source).body:
        if isinstance(node, ast.FunctionDef) and node.name == "pytest_ignore_collect":
            found.append("defines pytest_ignore_collect, which this check cannot evaluate")
        targets: list[ast.expr] = []
        if isinstance(node, ast.Assign):
            targets = list(node.targets)
        elif isinstance(node, ast.AnnAssign):
            targets = [node.target]
        for target in targets:
            if isinstance(target, ast.Name) and target.id in {
                "collect_ignore",
                "collect_ignore_glob",
            }:
                value = node.value if isinstance(node, ast.Assign | ast.AnnAssign) else None
                entries = (
                    [
                        element.value
                        for element in value.elts
                        if isinstance(element, ast.Constant) and isinstance(element.value, str)
                    ]
                    if isinstance(value, ast.List | ast.Tuple)
                    else None
                )
                if entries is None:
                    found.append(f"sets {target.id} to something this check cannot read")
                else:
                    found.extend(
                        f"sets {target.id} to {entry!r}" for entry in entries if _touches(entry)
                    )
    return found


def refusals(
    *,
    configuration: dict[str, Any],
    inventory: str,
    acceptance: str | None,
    present: set[str],
    rivals: set[str],
    conftests: dict[str, str],
) -> list[str]:
    """Everything that would keep a repository-root run from collecting all thirty-one rows.

    `configuration` is `pyproject.toml`, parsed; `inventory` is `acceptance.toml`'s text;
    `acceptance` is the acceptance module's source, or None when the file is absent; `present` is
    the file names under the directory; `rivals` is the rival configuration files at the root;
    `conftests` maps each `conftest.py` above the directory to its source.
    """
    found: list[str] = []
    rows = tomllib.loads(inventory).get("test", [])
    identifiers = [row.get("id") for row in rows]
    if identifiers != EXPECTED:
        found.append(
            f"the inventory lists {len(identifiers)} rows, not exactly {EXPECTED[0]} to "
            f"{EXPECTED[-1]} in order"
        )
    for module in MODULES:
        if module not in present:
            found.append(f"{DIRECTORY / module} does not exist")
    marked = marked_functions(acceptance or "")
    for row in rows:
        carriers = marked.get(str(row.get("id")), [])
        if carriers != [row.get("function")]:
            found.append(
                f"{row.get('id')} names {row.get('function')}, but the acceptance module's "
                f"functions carrying that identifier are {carriers}"
            )
    for stray in sorted(set(marked) - {str(identifier) for identifier in identifiers}):
        found.append(f"the acceptance module marks {stray}, which the inventory does not list")

    options = configuration.get("tool", {}).get("pytest", {}).get("ini_options", {})
    patterns = options.get("python_files", DEFAULT_PYTHON_FILES)
    if isinstance(patterns, str):
        patterns = patterns.split()
    for module in MODULES:
        if not any(fnmatch.fnmatch(module, pattern) for pattern in patterns):
            found.append(f"python_files {patterns} does not match {module}")
    testpaths = options.get("testpaths", [])
    if isinstance(testpaths, str):
        testpaths = testpaths.split()
    roots = [PurePosixPath(path.rstrip("/")) for path in testpaths]
    if roots and not any(root == DIRECTORY or root in DIRECTORY.parents for root in roots):
        found.append(f"testpaths {testpaths} does not contain {DIRECTORY}")
    norecurse = options.get("norecursedirs", [])
    if isinstance(norecurse, str):
        norecurse = norecurse.split()
    for pattern in norecurse:
        if any(fnmatch.fnmatch(part, pattern) for part in DIRECTORY.parts) or _touches(pattern):
            found.append(f"norecursedirs {pattern!r} keeps pytest out of {DIRECTORY}")
    addopts = options.get("addopts", [])
    if isinstance(addopts, str):
        addopts = shlex.split(addopts)
    for name, value in _values(list(addopts)):
        if _touches(value):
            found.append(f"addopts carries {name} {value!r}, which leaves out {DIRECTORY}")
    for rival in sorted(rivals):
        found.append(
            f"{rival} exists at the repository root and may carry a pytest configuration this "
            "check does not read"
        )
    for path, source in sorted(conftests.items()):
        found.extend(f"{path} {reason}" for reason in _ignored_by(source))
    return found


def _tree() -> dict[str, Any]:
    """What this repository carries today."""
    directory = ROOT / DIRECTORY
    module = directory / MODULES[0]
    above = [ROOT / "conftest.py", ROOT / "tests" / "conftest.py"]
    return {
        "configuration": tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8")),
        "inventory": (directory / "acceptance.toml").read_text(encoding="utf-8"),
        "acceptance": module.read_text(encoding="utf-8") if module.is_file() else None,
        "present": {path.name for path in directory.iterdir()},
        "rivals": {name for name in RIVAL_CONFIGURATIONS if (ROOT / name).exists()},
        "conftests": {
            str(path.relative_to(ROOT)): path.read_text(encoding="utf-8")
            for path in above
            if path.is_file()
        },
    }


def _with_options(tree: dict[str, Any], **changed: Any) -> dict[str, Any]:
    options = dict(tree["configuration"]["tool"]["pytest"]["ini_options"])
    options.update(changed)
    tool = {**tree["configuration"]["tool"], "pytest": {"ini_options": options}}
    return {**tree, "configuration": {**tree["configuration"], "tool": tool}}


def test_a_repository_root_run_collects_all_twenty_eight_job_queue_rows() -> None:
    assert refusals(**_tree()) == []


def test_the_acceptance_module_carries_each_identifier_exactly_once() -> None:
    tree = _tree()
    marked = marked_functions(tree["acceptance"])
    assert sorted(marked) == EXPECTED
    assert all(len(functions) == 1 for functions in marked.values())


MUTATIONS: dict[str, tuple[Any, str]] = {
    "a python_files pattern that leaves the directory with no module": (
        lambda tree: _with_options(tree, python_files=["test_[!j]*.py"]),
        "python_files ['test_[!j]*.py'] does not match test_job_queue_acceptance.py",
    ),
    "a testpaths that leaves the directory out": (
        lambda tree: _with_options(tree, testpaths=["tests/first_slice"]),
        "testpaths ['tests/first_slice'] does not contain tests/job_queue",
    ),
    "a norecursedirs that names the directory": (
        lambda tree: _with_options(tree, norecursedirs=["job_*"]),
        "norecursedirs 'job_*' keeps pytest out of tests/job_queue",
    ),
    "an --ignore in addopts": (
        lambda tree: _with_options(tree, addopts=["--strict-markers", "--ignore=tests/job_queue"]),
        "addopts carries --ignore 'tests/job_queue', which leaves out tests/job_queue",
    ),
    "an --ignore-glob in addopts, as two words": (
        lambda tree: _with_options(tree, addopts=["--ignore-glob", "*job_queue*"]),
        "addopts carries --ignore-glob '*job_queue*', which leaves out tests/job_queue",
    ),
    "a --deselect of the acceptance module in addopts": (
        lambda tree: _with_options(
            tree, addopts="--deselect tests/job_queue/test_job_queue_acceptance.py"
        ),
        "addopts carries --deselect 'tests/job_queue/test_job_queue_acceptance.py', which leaves "
        "out tests/job_queue",
    ),
    "a collect_ignore in a conftest above the directory": (
        lambda tree: {**tree, "conftests": {"tests/conftest.py": 'collect_ignore = ["job_queue"]'}},
        "tests/conftest.py sets collect_ignore to 'job_queue'",
    ),
    "a collect_ignore_glob built at run time": (
        lambda tree: {**tree, "conftests": {"conftest.py": "collect_ignore_glob = build()"}},
        "conftest.py sets collect_ignore_glob to something this check cannot read",
    ),
    "a pytest_ignore_collect hook above the directory": (
        lambda tree: {
            **tree,
            "conftests": {"conftest.py": "def pytest_ignore_collect(collection_path): ..."},
        },
        "conftest.py defines pytest_ignore_collect, which this check cannot evaluate",
    ),
    "a pytest.ini that outranks pyproject.toml": (
        lambda tree: {**tree, "rivals": {"pytest.ini"}},
        "pytest.ini exists at the repository root and may carry a pytest configuration this check "
        "does not read",
    ),
    "the acceptance module renamed away": (
        lambda tree: {
            **tree,
            "present": tree["present"] - {"test_job_queue_acceptance.py"},
            "acceptance": None,
        },
        "tests/job_queue/test_job_queue_acceptance.py does not exist",
    ),
    "the self-test renamed away": (
        lambda tree: {**tree, "present": tree["present"] - {"test_job_queue_selftest.py"}},
        "tests/job_queue/test_job_queue_selftest.py does not exist",
    ),
    "an inventory row removed": (
        lambda tree: {
            **tree,
            "inventory": tree["inventory"].replace('id = "A3-27"', 'id = "A3-26"', 1),
        },
        "the inventory lists 31 rows, not exactly A3-01 to A3-31 in order",
    ),
    "a row whose function the acceptance module does not define": (
        lambda tree: {
            **tree,
            "acceptance": tree["acceptance"].replace(
                "def test_a3_26_a_claim_checks", "def test_a3_26_renamed_a_claim_checks", 1
            ),
        },
        "A3-26 names test_a3_26_a_claim_checks_reservations_again_once_it_holds_its_live_locks, "
        "but the acceptance module's functions carrying that identifier are "
        "['test_a3_26_renamed_a_claim_checks_reservations_again_once_it_holds_its_live_locks']",
    ),
    "a row whose test lost its marker": (
        lambda tree: {
            **tree,
            "acceptance": tree["acceptance"].replace('@job_queue_acceptance("A3-26")\n', "", 1),
        },
        "A3-26 names test_a3_26_a_claim_checks_reservations_again_once_it_holds_its_live_locks, "
        "but the acceptance module's functions carrying that identifier are []",
    ),
    "a marked test the inventory does not list": (
        lambda tree: {
            **tree,
            "acceptance": tree["acceptance"]
            + '\n\n@job_queue_acceptance("A3-32")\ndef test_a3_32_unlisted(queue_env):\n    pass\n',
        },
        "the acceptance module marks A3-32, which the inventory does not list",
    ),
}


@pytest.mark.parametrize("name", sorted(MUTATIONS))
def test_each_way_of_silencing_the_rows_is_refused_by_its_own_sentence(name: str) -> None:
    mutate, sentence = MUTATIONS[name]
    before = _tree()
    found = refusals(**mutate(before))
    assert sentence in found, found
    assert refusals(**before) == [], (
        "the unmutated tree must be accepted, or the mutation proves nothing"
    )
