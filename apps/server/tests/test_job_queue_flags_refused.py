"""No settings module but config.settings.test can enable a job-queue mutant flag.

docs/specs/JOB_QUEUE.md §9.2: each flag of tests/job_queue/mutants.toml disables a guard of
ADR-0004, so a flag reachable from any other settings module is a standing bypass. Every module
under config/settings/ except test.py is checked — a module file, a package, and each module inside
a package, at any depth — so a settings module added later is covered the day it lands. Each module
is started in a child interpreter, once with no flag input and once per input it could read one
from, and must neither enable a flag, nor permit flags, nor accept flags assigned to it.

Starting a module once per input cannot see a module that permits flags only when two inputs agree,
or under a value other than the flag list. A static check covers that: no module under config/ but
config/settings/test.py may name the settings that permit or set flags, or import
config.settings.test. It reads names, attributes and strings, so a name built at run time, or a
setting read through a module outside config/, is not seen. The one closed immutable loopback
profile datum is not an import; an extra access, exposure or constructor shadow denies that
node-only exception, and all other nodes remain checked.
"""

from __future__ import annotations

import ast
import concurrent.futures
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

from config.environment import unadmitted_secret_names

ROOT = Path(__file__).resolve().parents[1]
FLAG_INPUTS = ("JOB_QUEUE_MUTANTS", "JOB_QUEUE_MUTANT")
MUTANT_SETTINGS = ("JOB_QUEUE_MUTANTS_PERMITTED", *FLAG_INPUTS)
TEST_SETTINGS = "config.settings.test"
WORKER_SETTINGS = "config.settings.deploy_worker"
WORKER_BOOT = "import worker.boot\nworker.boot.enter()\n"
ONLY_TEST = "only config/settings/test.py may permit or set job-queue mutant flags"
ENVIRONMENT_NAME = re.compile(r"[A-Z][A-Z0-9_]*")
# core/faults.py's named fault points are gated like the flags: only the test profile permits them.
FAULT_SETTINGS = ("FAULT_POINTS_PERMITTED",)
ONLY_TEST_FAULTS = "only config/settings/test.py may permit core fault points"

CHILD = """
import json
import sys

try:
    import django

    django.setup()
except Exception as error:
    print(json.dumps({"started": False, "error": f"{type(error).__name__}: {error}"}))
    sys.exit(0)

from django.conf import settings

from apps.jobs import mutants

try:
    enabled = sorted(mutants.active())
except mutants.MutantsRefused:
    enabled = []
permitted = getattr(settings, "JOB_QUEUE_MUTANTS_PERMITTED", False) is True
settings.JOB_QUEUE_MUTANTS = mutants.FLAGS
try:
    mutants.active()
except mutants.MutantsRefused:
    refused = True
else:
    refused = False
print(json.dumps({"started": True, "enabled": enabled, "permitted": permitted, "refused": refused}))
"""


def environment_names() -> list[str]:
    """Every environment variable name a module under config/ reads with a literal name: through
    os.environ[...], os.getenv(...), or .get(...) / [...] on the environment mapping it was given."""
    names: set[str] = set()
    for path in sorted((ROOT / "config").rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            literal: ast.expr | None = None
            if isinstance(node, ast.Call) and node.args:
                function = node.func
                if isinstance(function, ast.Attribute) and function.attr in {"get", "getenv"}:
                    literal = node.args[0]
            elif isinstance(node, ast.Subscript):
                literal = node.slice
            if (
                isinstance(literal, ast.Constant)
                and isinstance(literal.value, str)
                and ENVIRONMENT_NAME.fullmatch(literal.value)
            ):
                names.add(literal.value)
    return sorted(names)


# What django.test a process holds once it has started, imported every module of the queue's
# applications, read a flag and asked for one: the request is refused unless the settings permit it.
# The modules are those pkgutil finds: a directory without __init__.py is not walked, and an import
# written inside a function is not run.
MACHINERY_CHILD = """
import importlib
import json
import pkgutil
import sys

import django

django.setup()

from apps.jobs import mutants
from config.settings.job_queue import QUEUE_APPS

for application in QUEUE_APPS:
    package = importlib.import_module(application)
    for module in pkgutil.walk_packages(package.__path__, application + "."):
        importlib.import_module(module.name)
mutants.on("no_dedupe")
try:
    mutants.activate("no_dedupe")
except mutants.MutantsRefused:
    pass
print(json.dumps(sorted(name for name in sys.modules if name.startswith("django.test"))))
"""


def _child(
    script: str, settings_module: str, extra_path: Path | None, inputs: dict[str, str]
) -> object:
    """The last line `script` prints, as JSON, in a child interpreter started on `settings_module`
    with no flag input but `inputs`."""
    # Not the caller's own credentials either: a deployed profile refuses any it does not admit.
    environment = {
        key: value
        for key, value in os.environ.items()
        if key not in FLAG_INPUTS
        and key not in {"DJANGO_SETTINGS_MODULE", "PYTHONPATH"}
        and not unadmitted_secret_names({key: value})
    }
    if settings_module in {"config.settings.deploy", "config.settings.deploy_operator"}:
        environment.update(
            {
                "DJANGO_SECRET_KEY": "synthetic-deployment-only-" + "abc0123456789" * 5,
                "DJANGO_ALLOWED_HOSTS": "api.synthetic.test",
                "DATABASE_URL": "postgresql://synthetic:synthetic-pass@db/kodera_server",
            }
        )
    if settings_module == WORKER_SETTINGS:
        # The worker's profile loads only in a process that entered the worker's boundary.
        environment["DATABASE_URL"] = "postgresql://synthetic:synthetic-pass@db/kodera_server"
        script = WORKER_BOOT + script
    path = [str(ROOT)] if extra_path is None else [str(extra_path), str(ROOT)]
    environment.update(
        {"DJANGO_SETTINGS_MODULE": settings_module, "PYTHONPATH": os.pathsep.join(path), **inputs}
    )
    result = subprocess.run(  # noqa: S603 - a fixed interpreter and script
        [sys.executable, "-c", script],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    lines = result.stdout.strip().splitlines()
    if result.returncode != 0 or not lines:
        raise AssertionError(f"{settings_module} could not be checked: {result.stderr[-2000:]}")
    return json.loads(lines[-1])


def _start(
    settings_module: str, extra_path: Path | None, inputs: dict[str, str]
) -> dict[str, object]:
    report = _child(CHILD, settings_module, extra_path, inputs)
    assert isinstance(report, dict)
    return report


def flag_refusals(settings_module: str, extra_path: Path | None = None) -> list[str]:
    """Why `settings_module` could enable a job-queue mutant flag, or [].

    The module starts once with no flag input: it must start, and it must neither permit flags nor
    accept every flag assigned to its settings. It then starts once per input, with that input set
    to every flag joined by commas: JOB_QUEUE_MUTANTS, JOB_QUEUE_MUTANT and every environment
    variable any module under config/ reads. A start that fails enabled nothing; a start that
    succeeds must report no active flag."""
    from apps.jobs import mutants

    every_flag = ",".join(sorted(mutants.FLAGS))
    names = sorted(set(FLAG_INPUTS) | set(environment_names()))
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        clean = pool.submit(_start, settings_module, extra_path, {})
        runs = [
            pool.submit(_start, settings_module, extra_path, {name: every_flag}) for name in names
        ]
        base = clean.result()
        reports = [run.result() for run in runs]
    if not base["started"]:
        raise AssertionError(f"{settings_module} does not start: {base['error']}")
    refusals = []
    if base["enabled"]:
        refusals.append(f"{settings_module} enables job-queue mutant flags by itself")
    if any(report["started"] and report["enabled"] for report in reports):
        refusals.append(f"{settings_module} enables job-queue mutant flags from its inputs")
    if base["permitted"]:
        refusals.append(f"{settings_module} permits job-queue mutant flags")
    if not base["refused"]:
        refusals.append(f"{settings_module} does not refuse job-queue mutant flags assigned to it")
    return refusals


def _imported_module(node: ast.ImportFrom, package: tuple[str, ...]) -> str:
    base = package[: len(package) - node.level + 1] if node.level else ()
    return ".".join([*base, *([node.module] if node.module else [])])


def _imports_test_settings(node: ast.AST, package: tuple[str, ...]) -> bool:
    if isinstance(node, ast.Import):
        return any(alias.name == TEST_SETTINGS for alias in node.names)
    if isinstance(node, ast.ImportFrom):
        module = _imported_module(node, package)
        names = {alias.name for alias in node.names}
        return module == TEST_SETTINGS or (module == "config.settings" and "test" in names)
    return isinstance(node, ast.Constant) and node.value == TEST_SETTINGS


def _loopback_profile_datum(trees: dict[Path, ast.Module], config: Path) -> set[int]:
    """The one inert test-profile literal, only while its declaration and use stay closed."""
    tree = trees.get(config / "environment.py")
    if tree is None:
        return set()
    assignments = [
        node
        for node in tree.body
        if isinstance(node, ast.Assign)
        and any(
            isinstance(target, ast.Name) and target.id == "LOOPBACK_PROFILES"
            for target in node.targets
        )
    ]
    if len(assignments) != 1:
        return set()
    declaration = assignments[0]
    if len(declaration.targets) != 1 or not isinstance(declaration.targets[0], ast.Name):
        return set()
    call = declaration.value
    if not (
        isinstance(call, ast.Call)
        and isinstance(call.func, ast.Name)
        and call.func.id == "frozenset"
        and len(call.args) == 1
        and not call.keywords
        and isinstance(call.args[0], ast.Set)
    ):
        return set()
    elements = call.args[0].elts
    if len(elements) != 3 or not all(isinstance(node, ast.Constant) for node in elements):
        return set()
    if {node.value for node in elements if isinstance(node, ast.Constant)} != {
        TEST_SETTINGS,
        "config.settings.e2e",
        "config.settings.e2e_operator",
    }:
        return set()
    consumers = [
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "loopback_profile"
    ]
    if len(consumers) != 1:
        return set()
    consumer = consumers[0]
    arguments = consumer.args
    body = consumer.body
    if (
        body
        and isinstance(body[0], ast.Expr)
        and isinstance(body[0].value, ast.Constant)
        and isinstance(body[0].value.value, str)
    ):
        body = body[1:]
    if (
        consumer.decorator_list
        or arguments.posonlyargs
        or len(arguments.args) != 1
        or arguments.args[0].arg != "environment"
        or arguments.vararg
        or arguments.kwarg
        or arguments.kwonlyargs
        or arguments.defaults
        or len(body) != 1
        or not isinstance(body[0], ast.Return)
    ):
        return set()
    predicate = body[0].value
    expected = ast.parse(
        'environment.get("DJANGO_SETTINGS_MODULE") in LOOPBACK_PROFILES', mode="eval"
    ).body
    if predicate is None or ast.dump(predicate) != ast.dump(expected):
        return set()
    assert isinstance(predicate, ast.Compare)
    read = predicate.comparators[0]

    # A constructor alias/shadow or reflective binding is outside this tiny exception.
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Attribute)
            and node.attr == "frozenset"
            and isinstance(node.ctx, (ast.Store, ast.Del))
        ):
            return set()
        if (
            isinstance(node, (ast.MatchAs, ast.MatchStar, ast.ExceptHandler))
            and node.name == "frozenset"
        ):
            return set()
        if isinstance(node, ast.MatchMapping) and node.rest == "frozenset":
            return set()
        if (
            isinstance(node, ast.Name)
            and node.id == "frozenset"
            and isinstance(node.ctx, (ast.Store, ast.Del))
        ):
            return set()
        if (
            isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
            and node.name == "frozenset"
        ):
            return set()
        if isinstance(node, ast.arg) and node.arg == "frozenset":
            return set()
        if isinstance(node, ast.Constant) and node.value == "frozenset":
            return set()
        if isinstance(node, (ast.Import, ast.ImportFrom)) and any(
            alias.name == "*" or (alias.asname or alias.name.split(".")[0]) == "frozenset"
            for alias in node.names
        ):
            return set()

    for path, module in trees.items():
        package = path.relative_to(config.parent).with_suffix("").parts[:-1]
        for node in ast.walk(module):
            if (
                isinstance(node, (ast.MatchAs, ast.MatchStar, ast.ExceptHandler))
                and node.name == "LOOPBACK_PROFILES"
            ):
                return set()
            if isinstance(node, ast.MatchMapping) and node.rest == "LOOPBACK_PROFILES":
                return set()
            if isinstance(node, ast.Name) and node.id == "LOOPBACK_PROFILES":
                if node is not declaration.targets[0] and node is not read:
                    return set()
            if isinstance(node, ast.Attribute) and node.attr == "LOOPBACK_PROFILES":
                return set()
            if isinstance(node, ast.Constant) and node.value == "LOOPBACK_PROFILES":
                return set()
            if (
                isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                and node.name == "LOOPBACK_PROFILES"
            ):
                return set()
            if isinstance(node, ast.ImportFrom) and any(
                alias.name == "LOOPBACK_PROFILES"
                or alias.asname == "LOOPBACK_PROFILES"
                or (alias.name == "*" and _imported_module(node, package) == "config.environment")
                for alias in node.names
            ):
                return set()
            if isinstance(node, ast.Import) and any(
                (alias.asname or alias.name.split(".")[0]) == "LOOPBACK_PROFILES"
                for alias in node.names
            ):
                return set()
    return {
        id(node)
        for node in elements
        if isinstance(node, ast.Constant) and node.value == TEST_SETTINGS
    }


def static_refusals(
    config: Path, names: tuple[str, ...] = MUTANT_SETTINGS, only: str = ONLY_TEST
) -> list[str]:
    """Why a module under `config`, other than settings/test.py, could permit or set a flag, or [].

    A module may not name JOB_QUEUE_MUTANTS_PERMITTED, JOB_QUEUE_MUTANTS or JOB_QUEUE_MUTANT — as a
    name, an attribute or a string — nor import config.settings.test, by statement or by name. With
    `names` and `only`, the same rule for another test-only permission. Only the exact closed
    immutable loopback-profile datum is not an import; every other node remains checked."""
    found: dict[tuple[str, int, str], None] = {}
    trees = {
        path: ast.parse(path.read_text(encoding="utf-8"))
        for path in sorted(config.rglob("*.py"))
        if path != config / "settings" / "test.py"
    }
    data_nodes = _loopback_profile_datum(trees, config)
    for path, tree in trees.items():
        relative = path.relative_to(config.parent)
        package = relative.with_suffix("").parts[:-1]
        for node in ast.walk(tree):
            named = None
            if isinstance(node, ast.Name):
                named = node.id
            elif isinstance(node, ast.Attribute):
                named = node.attr
            elif isinstance(node, ast.Constant) and isinstance(node.value, str):
                named = node.value
            line = getattr(node, "lineno", 0)
            if named in names:
                found[(relative.as_posix(), line, f"names {named}")] = None
            elif id(node) not in data_nodes and _imports_test_settings(node, package):
                found[(relative.as_posix(), line, f"imports {TEST_SETTINGS}")] = None
    return [f"{path}:{line} {what}: {only}" for path, line, what in sorted(found)]


def settings_modules(settings: Path) -> list[str]:
    """Every settings module under `settings` but config.settings.test, by dotted name: a module
    file, a package (its __init__.py) and each module inside a package, at any depth. A symbolic
    link to a directory is not followed. scripts/ci/check-job-queue-rows.py walks the same way
    and requires one report per name it finds."""
    names = set()
    for path in settings.rglob("*.py"):
        parts = path.relative_to(settings).with_suffix("").parts
        if parts[-1] == "__init__":
            parts = parts[:-1]
        if parts and parts != ("test",):
            names.add(".".join(("config", "settings", *parts)))
    return sorted(names)


NON_TEST_MODULES = settings_modules(ROOT / "config" / "settings")


def test_every_settings_module_but_test_is_checked() -> None:
    assert NON_TEST_MODULES, "no settings module was found to check"
    # The one module but test.py that installs the queue, so the one that starts apps.jobs.
    assert "config.settings.job_queue" in NON_TEST_MODULES


@pytest.mark.parametrize("module", NON_TEST_MODULES)
def test_no_settings_module_but_test_can_enable_a_mutant_flag(module: str) -> None:
    assert flag_refusals(module) == [], f"{module} could enable a job-queue mutant flag"


def test_the_refusal_check_fails_a_settings_module_that_reads_its_flags_from_input(
    tmp_path: Path,
) -> None:
    (tmp_path / "mutated_settings.py").write_text(
        "import os\nfrom config.settings.job_queue import *\n"
        # Deliberately remove runtime admission in this disposable child: this test proves
        # the scanner still catches a reachable flag, independently of the production guard.
        "from apps.jobs import mutants\nmutants._require_permitted = lambda: None\n"
        "JOB_QUEUE_MUTANTS_PERMITTED = True\n"
        "JOB_QUEUE_MUTANTS = frozenset(filter(None, os.environ.get('JOB_QUEUE_MUTANTS', '').split(',')))\n",
        encoding="utf-8",
    )
    assert flag_refusals("mutated_settings", extra_path=tmp_path) == [
        "mutated_settings enables job-queue mutant flags from its inputs",
        "mutated_settings permits job-queue mutant flags",
        "mutated_settings does not refuse job-queue mutant flags assigned to it",
    ], "the refusal check passed a settings module that reads its flags from the environment"


def test_the_environment_walk_finds_the_names_config_reads() -> None:
    names = environment_names()
    for name in ("DATABASE_URL", "DJANGO_SECRET_KEY", "KODERA_AUTH_TRUST"):
        assert name in names, f"the walk of config/ missed {name}"


def test_the_refusal_check_fails_a_settings_module_that_enables_flags_by_itself(
    tmp_path: Path,
) -> None:
    (tmp_path / "alone_settings.py").write_text(
        "from config.settings.job_queue import *\n"
        "from apps.jobs import mutants\nmutants._require_permitted = lambda: None\n"
        "JOB_QUEUE_MUTANTS_PERMITTED = True\n"
        "JOB_QUEUE_MUTANTS = frozenset({'no_dedupe'})\n",
        encoding="utf-8",
    )
    assert flag_refusals("alone_settings", extra_path=tmp_path) == [
        "alone_settings enables job-queue mutant flags by itself",
        "alone_settings enables job-queue mutant flags from its inputs",
        "alone_settings permits job-queue mutant flags",
        "alone_settings does not refuse job-queue mutant flags assigned to it",
    ], "the refusal check passed a settings module that enables a flag with no input"


def test_the_refusal_check_fails_a_settings_module_that_does_not_start(tmp_path: Path) -> None:
    (tmp_path / "broken_settings.py").write_text(
        "raise RuntimeError('this settings module is broken')\n", encoding="utf-8"
    )
    with pytest.raises(AssertionError) as refused:
        flag_refusals("broken_settings", extra_path=tmp_path)
    assert str(refused.value) == (
        "broken_settings does not start: RuntimeError: this settings module is broken"
    ), "the refusal check did not name a settings module that does not start"


def test_no_module_under_config_but_test_names_the_mutant_settings() -> None:
    assert static_refusals(ROOT / "config") == [], "a module under config/ could permit flags"


def test_the_static_check_fails_a_module_that_names_the_mutant_settings(tmp_path: Path) -> None:
    settings = tmp_path / "config" / "settings"
    settings.mkdir(parents=True)
    (settings / "test.py").write_text(
        "JOB_QUEUE_MUTANTS_PERMITTED = True\nJOB_QUEUE_MUTANTS = frozenset()\n", encoding="utf-8"
    )
    # Permitted only when two inputs agree: each input alone enables nothing, so the start-up
    # check above passes this module.
    (settings / "production.py").write_text(
        "import os\n"
        "JOB_QUEUE_MUTANTS_PERMITTED = os.environ.get('KODERA_TEST_HOOKS') == '1'\n"
        "JOB_QUEUE_MUTANTS = frozenset(os.environ.get('JOB_QUEUE_MUTANTS', '').split(','))\n",
        encoding="utf-8",
    )
    (settings / "local.py").write_text("from .test import DEBUG\n", encoding="utf-8")
    (settings / "staging.py").write_text(
        "import importlib\nimportlib.import_module('config.settings.test')\n", encoding="utf-8"
    )
    only = "only config/settings/test.py may permit or set job-queue mutant flags"
    assert static_refusals(tmp_path / "config") == [
        f"config/settings/local.py:1 imports config.settings.test: {only}",
        f"config/settings/production.py:2 names JOB_QUEUE_MUTANTS_PERMITTED: {only}",
        f"config/settings/production.py:3 names JOB_QUEUE_MUTANTS: {only}",
        f"config/settings/staging.py:2 imports config.settings.test: {only}",
    ], "the static check passed a module that permits flags from a combination of inputs"


def test_a_process_that_reads_a_flag_loads_no_test_machinery() -> None:
    """JobsConfig.ready() imports apps.jobs.mutants in every process that installs the queue, and
    each guard reads its flag there: no module of the queue's applications may bring django.test
    with it, and neither may a flag read or a refused activate(). Only a permitted activate() needs
    it, and only the test settings permit one."""
    assert _child(MACHINERY_CHILD, "config.settings.job_queue", None, {}) == [], (
        "a process that imports the queue, reads a mutant flag and is refused one loads django.test"
    )


def test_the_machinery_check_sees_a_process_that_activates_a_flag() -> None:
    """The same child under the test settings, where activate() is permitted: the list it prints is
    not empty, so the check above does not pass because it cannot see django.test."""
    loaded = _child(MACHINERY_CHILD, "config.settings.test", None, {})
    assert isinstance(loaded, list) and "django.test.utils" in loaded, (
        "the machinery check did not see django.test in a process that activated a flag"
    )


def test_the_settings_walk_finds_a_settings_package_and_the_modules_inside_it(
    tmp_path: Path,
) -> None:
    settings = tmp_path / "config" / "settings"
    (settings / "production" / "regions").mkdir(parents=True)
    for name in (
        "__init__.py",
        "test.py",
        "dev.py",
        "production/__init__.py",
        "production/base.py",
        "production/test.py",
        "production/regions/paris.py",
        "production/regions/europe/west.py",
        "test/__init__.py",
        "test/extra.py",
    ):
        (settings / name).parent.mkdir(parents=True, exist_ok=True)
        (settings / name).write_text("", encoding="utf-8")
    # Only the module config.settings.test is left out: a test.py inside another package, and a
    # module inside a test package, are checked.
    assert settings_modules(settings) == [
        "config.settings.dev",
        "config.settings.production",
        "config.settings.production.base",
        "config.settings.production.regions.europe.west",
        "config.settings.production.regions.paris",
        "config.settings.production.test",
        "config.settings.test.extra",
    ], "the walk of config/settings/ missed a settings package or a module inside one"


DATABASE_MACHINERY_CHILD = """
import importlib
import json
import sys

import django

django.setup()
from apps.jobs import mutants

for name in ("apps.jobs.services", "apps.outbox.services"):
    importlib.import_module(name)
installer_names = (
    "DATABASE_MUTANTS", "install_database_mutant", "snapshot_guards", "restore_database",
    "apply_marker", "pristine_differences", "Marker", "CheckRewrite", "DropConstraint",
)
print(json.dumps(
    [name for name in installer_names if hasattr(mutants, name)]
    + [name for name in sys.modules if name == "database_mutants" or name.endswith(".database_mutants")]
))
"""


def test_queue_runtime_exposes_no_database_mutation_machinery() -> None:
    assert _child(DATABASE_MACHINERY_CHILD, "config.settings.job_queue", None, {}) == [], (
        "queue runtime exposes database mutation machinery"
    )


def test_the_database_machinery_check_detects_an_exposed_installer() -> None:
    mutated = DATABASE_MACHINERY_CHILD.replace(
        "print(json.dumps(",
        "mutants.install_database_mutant = lambda: None\nprint(json.dumps(",
    )
    exposed = _child(mutated, "config.settings.job_queue", None, {})
    assert isinstance(exposed, list) and "install_database_mutant" in exposed, (
        "the runtime machinery check missed an exposed database installer"
    )


# What arming each named fault point does in a process started on one settings module: refused by the
# gate, before and after the permission is assigned to that module's settings.
FAULT_CHILD = """
import json
import threading

import django

django.setup()

from django.conf import settings

from core import faults


class Barrier:
    def __init__(self):
        self.reached = threading.Event()
        self.released = threading.Event()


def arms():
    armed = []
    for point, spec in faults.POINTS.items():
        try:
            faults.arm(point, hold=Barrier() if spec.mode == "hold" else None)
        except faults.FaultPointsRefused as error:
            if not str(error).startswith("fault points are refused"):
                armed.append(point + " refused for another reason: " + str(error))
        else:
            armed.append(point)
            faults.disarm(point)
    return armed


permitted = getattr(settings, "FAULT_POINTS_PERMITTED", False) is True
armed = arms()
settings.FAULT_POINTS_PERMITTED = True
assigned = arms()
print(json.dumps({"permitted": permitted, "armed": armed, "assigned": assigned}))
"""


def fault_point_refusals(settings_module: str, extra_path: Path | None = None) -> list[str]:
    """Why `settings_module` could arm a core fault point, or []: it permits them, a point arms
    under it, or one arms once the permission is assigned to its settings."""
    report = _child(FAULT_CHILD, settings_module, extra_path, {})
    assert isinstance(report, dict)
    refusals = []
    if report["permitted"]:
        refusals.append(f"{settings_module} permits core fault points")
    if report["armed"]:
        refusals.append(f"{settings_module} arms {', '.join(report['armed'])}")
    if report["assigned"]:
        refusals.append(
            f"{settings_module} arms {', '.join(report['assigned'])} once the permission is assigned"
        )
    return refusals


@pytest.mark.parametrize("module", NON_TEST_MODULES)
def test_no_settings_module_but_test_can_arm_a_fault_point(module: str) -> None:
    assert fault_point_refusals(module) == [], f"{module} could arm a core fault point"


def test_the_fault_point_check_fails_a_settings_module_that_permits_them(tmp_path: Path) -> None:
    (tmp_path / "faulty_settings.py").write_text(
        "from config.settings.job_queue import *\n"
        # Deliberately remove the gate in this disposable child: this test proves the check still
        # sees a point that arms, independently of the gate.
        "from core import faults\nfaults._require_permitted = lambda: None\n"
        "FAULT_POINTS_PERMITTED = True\n",
        encoding="utf-8",
    )
    points = ", ".join(sorted_points())
    assert fault_point_refusals("faulty_settings", extra_path=tmp_path) == [
        "faulty_settings permits core fault points",
        f"faulty_settings arms {points}",
        f"faulty_settings arms {points} once the permission is assigned",
    ], "the fault-point check passed a settings module that arms every point"


def sorted_points() -> list[str]:
    from core import faults

    return list(faults.POINTS)


def test_no_module_under_config_but_test_names_the_fault_point_permission() -> None:
    assert static_refusals(ROOT / "config", FAULT_SETTINGS, ONLY_TEST_FAULTS) == [], (
        "a module under config/ could permit core fault points"
    )


def test_the_static_check_fails_a_module_that_names_the_fault_point_permission(
    tmp_path: Path,
) -> None:
    settings = tmp_path / "config" / "settings"
    settings.mkdir(parents=True)
    (settings / "test.py").write_text("FAULT_POINTS_PERMITTED = True\n", encoding="utf-8")
    (settings / "production.py").write_text(
        "import os\nFAULT_POINTS_PERMITTED = os.environ.get('KODERA_FAULTS') == '1'\n",
        encoding="utf-8",
    )
    assert static_refusals(tmp_path / "config", FAULT_SETTINGS, ONLY_TEST_FAULTS) == [
        f"config/settings/production.py:2 names FAULT_POINTS_PERMITTED: {ONLY_TEST_FAULTS}",
    ], "the static check passed a module that permits core fault points from its input"


def _loopback_datum_source() -> str:
    return (
        'LOOPBACK_PROFILES = frozenset({"config.settings.test", "config.settings.e2e", '
        '"config.settings.e2e_operator"})\n'
        "\n"
        "def loopback_profile(environment):\n"
        '    """Whether the selected settings module is one of LOOPBACK_PROFILES."""\n'
        '    return environment.get("DJANGO_SETTINGS_MODULE") in LOOPBACK_PROFILES\n'
    )


STATIC_PERMISSION_SCANS = [(MUTANT_SETTINGS, ONLY_TEST), (FAULT_SETTINGS, ONLY_TEST_FAULTS)]


@pytest.mark.parametrize("names,only", STATIC_PERMISSION_SCANS, ids=["mutants", "faults"])
def test_static_loopback_datum_is_not_a_test_settings_import(tmp_path, names, only):
    config = tmp_path / "config"
    config.mkdir()
    (config / "environment.py").write_text(_loopback_datum_source())
    assert static_refusals(config, names, only) == [], (
        "ImmutableLoopbackProfileDatumWasTreatedAsImport"
    )


@pytest.mark.parametrize("names,only", STATIC_PERMISSION_SCANS, ids=["mutants", "faults"])
@pytest.mark.parametrize(
    "mutation",
    [
        "other-file",
        "renamed",
        "multiple-target",
        "mutable",
        "dynamic-member",
        "extra-member",
        "duplicate-member",
        "constructor-alias",
        "constructor-shadow",
        "constructor-reflective",
        "constructor-attribute",
        "constructor-delete",
        "constructor-match",
        "constructor-star",
        "constructor-mapping",
        "constructor-except",
        "reassignment",
        "extra-read",
        "attribute-read",
        "member-import",
        "star-import",
        "indirect-import",
        "reflective-read",
        "reflective-attribute",
        "export-name",
        "allowlist-match",
        "allowlist-mapping",
        "allowlist-except",
        "changed-predicate",
        "extra-consumer-expression",
        "extra-consumer-string",
    ],
)
def test_static_loopback_datum_refuses_context_mutations(tmp_path, names, only, mutation):
    config = tmp_path / "config"
    config.mkdir()
    source = _loopback_datum_source()
    filename, line = "environment.py", 1
    if mutation == "other-file":
        filename = "other.py"
    elif mutation == "renamed":
        source = source.replace("LOOPBACK_PROFILES", "OTHER_PROFILES")
    elif mutation == "multiple-target":
        source = source.replace("LOOPBACK_PROFILES =", "OTHER = LOOPBACK_PROFILES =", 1)
    elif mutation == "mutable":
        source = source.replace("frozenset(", "set(", 1)
    elif mutation == "dynamic-member":
        source = source.replace('"config.settings.test"', '("config.settings.test" + "")', 1)
    elif mutation in {"extra-member", "duplicate-member"}:
        extra = "config.settings.customer_http" if mutation == "extra-member" else TEST_SETTINGS
        source = source.replace("})", f', "{extra}"}})', 1)
    elif mutation == "constructor-alias":
        source = "from builtins import frozenset as frozen\n" + source.replace(
            "frozenset(", "frozen(", 1
        )
        line = 2
    elif mutation == "constructor-shadow":
        source = "frozenset = lambda values: values\n" + source
        line = 2
    elif mutation == "constructor-reflective":
        source = 'globals()["frozenset"] = lambda values: values\n' + source
        line = 2
    elif mutation in {"constructor-attribute", "constructor-delete"}:
        operation = (
            "builtins.frozenset = lambda values: values"
            if mutation == "constructor-attribute"
            else "del builtins.frozenset"
        )
        source = "import builtins\n" + operation + "\n" + source
        line = 3
    elif mutation in {"constructor-match", "constructor-star", "constructor-mapping"}:
        matches = {
            "constructor-match": "match set:\n    case frozenset:\n        pass\n",
            "constructor-star": "match [set]:\n    case [*frozenset]:\n        pass\n",
            "constructor-mapping": "match {}:\n    case {**frozenset}:\n        pass\n",
        }
        source = matches[mutation] + source
        line = 4
    elif mutation == "constructor-except":
        source = "try:\n    pass\nexcept Exception as frozenset:\n    pass\n" + source
        line = 5
    elif mutation == "reassignment":
        source += "LOOPBACK_PROFILES = frozenset()\n"
    elif mutation == "extra-read":
        source += "seen = LOOPBACK_PROFILES\n"
    elif mutation == "attribute-read":
        source += "seen = holder.LOOPBACK_PROFILES\n"
    elif mutation == "member-import":
        source += "from config.environment import LOOPBACK_PROFILES as policy\n"
    elif mutation == "star-import":
        source += "from config.environment import *\n"
    elif mutation == "indirect-import":
        source += "import importlib\nimportlib.import_module(next(iter(LOOPBACK_PROFILES)))\n"
    elif mutation == "reflective-read":
        source += 'exposed = globals()["LOOPBACK_PROFILES"]\n'
    elif mutation == "reflective-attribute":
        source += 'exposed = getattr(holder, "LOOPBACK_PROFILES")\n'
    elif mutation == "export-name":
        source += '__all__ = ["LOOPBACK_PROFILES"]\n'
    elif mutation == "allowlist-match":
        source += "match set:\n    case LOOPBACK_PROFILES:\n        pass\n"
    elif mutation == "allowlist-mapping":
        source += "match {}:\n    case {**LOOPBACK_PROFILES}:\n        pass\n"
    elif mutation == "allowlist-except":
        source += "try:\n    pass\nexcept Exception as LOOPBACK_PROFILES:\n    pass\n"
    elif mutation == "extra-consumer-expression":
        source = source.replace("    return ", "    danger()\n    return ")
    elif mutation == "extra-consumer-string":
        source = source.replace("    return ", '    "not-a-docstring"\n    return ')
    else:
        source = source.replace(" in LOOPBACK_PROFILES", " not in LOOPBACK_PROFILES")
    (config / filename).write_text(source)
    assert static_refusals(config, names, only) == [
        f"config/{filename}:{line} imports {TEST_SETTINGS}: {only}",
    ], mutation


@pytest.mark.parametrize("names,only", STATIC_PERMISSION_SCANS, ids=["mutants", "faults"])
@pytest.mark.parametrize(
    "unsafe",
    [
        "direct-import",
        "relative-import",
        "relative-module",
        "dynamic-import",
        "name",
        "attribute",
        "string",
        "same-line-name",
        "same-line-string",
    ],
)
def test_static_loopback_datum_does_not_hide_another_unsafe_node(tmp_path, names, only, unsafe):
    config = tmp_path / "config"
    config.mkdir()
    source = _loopback_datum_source()
    name = names[0]
    statements = {
        "direct-import": "import config.settings.test\n",
        "relative-import": "from .settings import test\n",
        "relative-module": "from .settings.test import DEBUG\n",
        "dynamic-import": '__import__("config.settings.test")\n',
        "name": f"{name} = True\n",
        "attribute": f"seen = settings.{name}\n",
        "string": f'seen = "{name}"\n',
    }
    line = len(source.splitlines()) + 1
    if unsafe.startswith("same-line-"):
        statement = f"{name} = True" if unsafe == "same-line-name" else f'seen = "{name}"'
        source = source.replace("\n", "; " + statement + "\n", 1)
        line = 1
    else:
        source += statements[unsafe]
    (config / "environment.py").write_text(source)
    what = (
        f"imports {TEST_SETTINGS}"
        if unsafe.endswith("import") or unsafe == "relative-module"
        else f"names {name}"
    )
    assert static_refusals(config, names, only) == [
        f"config/environment.py:{line} {what}: {only}",
    ], unsafe
