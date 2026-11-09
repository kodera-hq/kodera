"""No application imports another application's models: docs/dev/PROJECT_LAYOUT.md §2.

Every module under apps/ is read. Its import statements are resolved, absolute and relative,
wherever they stand in the module, and so is every attribute read through a name an import bound
(`second.models` after `from apps import second`). A name stands, for the whole module, for
everything any import of the module bound it to, whatever scope bound it.

A models module is held to more, the models row of that section's layer table: it neither imports
anything of another application nor reads anything of one through a name an import bound.

Two more rows of the table are checked. A module under apps/<application>/api/ imports no models
module of any application, its own included, and nothing of another application, and reads none of
them through a name an import bound. A module under core/ imports nothing of apps or worker. Each
of these two checks fails when the only modules it finds are `__init__.py`, so a tree of empty
packages cannot pass. A module under worker/ imports no application's models or api module (the
worker/ row; it touches services, not models), and that check fails on a worker/ of `__init__.py`
alone too. The view-scope rule is test_view_scopes.py.

Not seen, by any of these checks: an import built at run time (importlib, __import__, getattr with a
string); a bound name assigned to another name (`other = second`, then `other.models`); the names
a star import binds; and a model another application re-exports from a module that is not its
models, which reads here as an import of that module.
"""

from __future__ import annotations

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _imported(node: ast.Import | ast.ImportFrom, package: tuple[str, ...]) -> list[str]:
    """The dotted names an import statement binds, a relative one resolved against `package`."""
    if isinstance(node, ast.Import):
        return [alias.name for alias in node.names]
    base = package[: len(package) - node.level + 1] if node.level else ()
    module = ".".join([*base, *([node.module] if node.module else [])])
    return [f"{module}.{alias.name}" for alias in node.names]


def _bound(node: ast.Import | ast.ImportFrom, package: tuple[str, ...]) -> dict[str, str]:
    """The names an import statement binds in its module, each with the dotted name it stands
    for: `import a.b` binds `a`, `import a.b as c` binds `c` to a.b."""
    if isinstance(node, ast.Import):
        return {
            alias.asname or alias.name.split(".")[0]: alias.name
            if alias.asname
            else alias.name.split(".")[0]
            for alias in node.names
        }
    return {
        alias.asname or alias.name: name
        for alias, name in zip(node.names, _imported(node, package), strict=True)
    }


def _read(node: ast.Attribute, bound: dict[str, set[str]]) -> list[str]:
    """The dotted names an attribute chain may read when it starts at a bound name, or []."""
    attributes = []
    value: ast.expr = node
    while isinstance(value, ast.Attribute):
        attributes.append(value.attr)
        value = value.value
    if not isinstance(value, ast.Name):
        return []
    return [".".join([start, *reversed(attributes)]) for start in sorted(bound.get(value.id, ()))]


def _foreign_models(name: str, owner: str) -> str | None:
    """The other application whose models the dotted `name` is, or is under, or None."""
    parts = name.split(".")
    if len(parts) >= 3 and parts[0] == "apps" and parts[2] == "models" and parts[1] != owner:
        return parts[1]
    return None


def _application_modules(root: Path) -> list[tuple[Path, tuple[str, ...], str, ast.Module]]:
    """Every module under `root`/apps: its path from `root`, its package, the application that
    owns it and its tree."""
    modules = []
    for path in sorted((root / "apps").rglob("*.py")):
        relative = path.relative_to(root)
        package = relative.with_suffix("").parts[:-1]
        owner = package[1] if len(package) > 1 else ""
        modules.append((relative, package, owner, ast.parse(path.read_text(encoding="utf-8"))))
    return modules


def cross_application_model_imports(root: Path) -> list[str]:
    """Every module of an application under `root`/apps that imports another application's
    models, or reads them through a name an import bound, or []."""
    found: set[tuple[str, int, str, str]] = set()
    for relative, package, owner, tree in _application_modules(root):
        bound: dict[str, set[str]] = {}
        for node in ast.walk(tree):
            if not isinstance(node, ast.Import | ast.ImportFrom):
                continue
            for name, stands_for in _bound(node, package).items():
                bound.setdefault(name, set()).add(stands_for)
            for name in _imported(node, package):
                other = _foreign_models(name, owner)
                if other:
                    found.add((relative.as_posix(), node.lineno, "imports", other))
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute):
                for name in _read(node, bound):
                    other = _foreign_models(name, owner)
                    if other:
                        found.add((relative.as_posix(), node.lineno, "reads", other))
    return [
        f"{path}:{line} {verb} apps.{other}.models" for path, line, verb, other in sorted(found)
    ]


def _foreign(name: str, owner: str) -> bool:
    """Whether the dotted `name` is in an application other than `owner`."""
    parts = name.split(".")
    return len(parts) >= 2 and parts[0] == "apps" and parts[1] != owner


def foreign_imports_in_models(root: Path) -> list[str]:
    """Every import, by a models module under `root`/apps, of anything in another application, and
    every read of one through a name an import bound, or []. A models module is
    apps/<application>/models.py or a module of a models package. A read is reported once, as its
    whole attribute chain."""
    found: set[tuple[str, int, str, str]] = set()
    for relative, package, owner, tree in _application_modules(root):
        if relative.with_suffix("").parts[2:3] != ("models",):
            continue
        bound: dict[str, set[str]] = {}
        for node in ast.walk(tree):
            if not isinstance(node, ast.Import | ast.ImportFrom):
                continue
            for name, stands_for in _bound(node, package).items():
                bound.setdefault(name, set()).add(stands_for)
            for name in _imported(node, package):
                if _foreign(name, owner):
                    found.add((relative.as_posix(), node.lineno, "imports", name))
        inner = {id(node.value) for node in ast.walk(tree) if isinstance(node, ast.Attribute)}
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and id(node) not in inner:
                for name in _read(node, bound):
                    if _foreign(name, owner):
                        found.add((relative.as_posix(), node.lineno, "reads", name))
    return [f"{path}:{line} {verb} {name}" for path, line, verb, name in sorted(found)]


def _models_module(name: str) -> str | None:
    """The models module of an application the dotted `name` is, or is under, or None."""
    parts = name.split(".")
    if len(parts) >= 3 and parts[0] == "apps" and parts[2] == "models":
        return ".".join(parts[:3])
    return None


def _forbidden_to_api(name: str, owner: str) -> str | None:
    """What the dotted `name` reaches that an api module of `owner` may not: a models module of any
    application, or anything of another application; or None."""
    return _models_module(name) or (
        ".".join(name.split(".")[:2]) if _foreign(name, owner) else None
    )


def forbidden_api_imports(root: Path) -> list[str]:
    """Every import, by a module under `root`/apps/<application>/api/, of a models module of any
    application, its own included, or of anything of another application, and every read of one
    through a name an import bound; or a single failure when the only modules there are
    `__init__.py`, so a tree of empty packages cannot pass."""
    modules = [module for module in _application_modules(root) if module[1][2:3] == ("api",)]
    if all(module[0].name == "__init__.py" for module in modules):
        return ["no module under apps/*/api/ other than __init__.py"]
    found: set[tuple[str, int, str, str]] = set()
    for relative, package, owner, tree in modules:
        bound: dict[str, set[str]] = {}
        for node in ast.walk(tree):
            if not isinstance(node, ast.Import | ast.ImportFrom):
                continue
            for name, stands_for in _bound(node, package).items():
                bound.setdefault(name, set()).add(stands_for)
            for name in _imported(node, package):
                forbidden = _forbidden_to_api(name, owner)
                if forbidden:
                    found.add((relative.as_posix(), node.lineno, "imports", forbidden))
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute):
                for name in _read(node, bound):
                    forbidden = _forbidden_to_api(name, owner)
                    if forbidden:
                        found.add((relative.as_posix(), node.lineno, "reads", forbidden))
    return [f"{path}:{line} {verb} {name}" for path, line, verb, name in sorted(found)]


def core_imports_of_apps_or_worker(root: Path) -> list[str]:
    """Every import, by a module under `root`/core, of anything in `apps` or `worker`; or a single
    failure when the only modules there are `__init__.py`, so a tree of empty packages cannot pass.
    Reads through a bound name
    are not followed: a name can only stand for something in `apps` or `worker` after an import
    of it, which this check already reports."""
    paths = sorted((root / "core").rglob("*.py"))
    if all(path.name == "__init__.py" for path in paths):
        return ["no module under core/ other than __init__.py"]
    found: set[tuple[str, int, str]] = set()
    for path in paths:
        relative = path.relative_to(root)
        package = relative.with_suffix("").parts[:-1]
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if not isinstance(node, ast.Import | ast.ImportFrom):
                continue
            for name in _imported(node, package):
                if name.split(".")[0] in ("apps", "worker"):
                    found.add((relative.as_posix(), node.lineno, name))
    return [f"{path}:{line} imports {name}" for path, line, name in sorted(found)]


def worker_imports_of_models_or_api(root: Path) -> list[str]:
    """Every import, by a module under `root`/worker, of an application's models or api module;
    or a single failure when the only modules there are `__init__.py`."""
    paths = sorted((root / "worker").rglob("*.py"))
    if all(path.name == "__init__.py" for path in paths):
        return ["no module under worker/ other than __init__.py"]
    found: set[tuple[str, int, str]] = set()
    for path in paths:
        relative = path.relative_to(root)
        package = relative.with_suffix("").parts[:-1]
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if not isinstance(node, ast.Import | ast.ImportFrom):
                continue
            for name in _imported(node, package):
                parts = name.split(".")
                if parts[0] == "apps" and len(parts) > 2 and parts[2] in ("models", "api"):
                    found.add((relative.as_posix(), node.lineno, name))
    return [f"{path}:{line} imports {name}" for path, line, name in sorted(found)]


def test_no_application_imports_another_applications_models() -> None:
    assert cross_application_model_imports(ROOT) == [], (
        "an application imports another application's models"
    )


def test_no_models_module_imports_another_application() -> None:
    assert foreign_imports_in_models(ROOT) == [], "a models module imports another application"


def test_no_api_module_reaches_a_models_module_or_another_application() -> None:
    assert forbidden_api_imports(ROOT) == [], (
        "an api module reaches a models module or another application"
    )


def test_no_core_module_imports_apps_or_worker() -> None:
    assert core_imports_of_apps_or_worker(ROOT) == [], "a core module imports apps or worker"


def test_the_models_check_names_a_models_module_importing_another_application(
    tmp_path: Path,
) -> None:
    first = tmp_path / "apps" / "first"
    (first / "models").mkdir(parents=True)
    (tmp_path / "apps" / "second").mkdir()
    (first / "models" / "__init__.py").write_text(
        "from django.db import models\nfrom core.db.ids import new_uuid7\n"
        "from apps.first.types import OWN\nfrom ..types import ALSO_OWN\n"
        "from apps.second.types import ROLE\n",
        encoding="utf-8",
    )
    (first / "models" / "records.py").write_text(
        "from ... import second\n\n\ndef late():\n    import apps.second.services\n",
        encoding="utf-8",
    )
    (first / "services.py").write_text("from apps.second.services import f\n", encoding="utf-8")
    (tmp_path / "apps" / "second" / "models.py").write_text(
        "from apps.first import selectors as read\n", encoding="utf-8"
    )
    # Another application reached through a name an import bound, with no import naming it.
    (first / "models" / "late.py").write_text(
        "import apps\n\nROLE = apps.second.types.ROLE\nOWN = apps.first.types.OWN\n",
        encoding="utf-8",
    )
    assert foreign_imports_in_models(tmp_path) == [
        "apps/first/models/__init__.py:5 imports apps.second.types.ROLE",
        "apps/first/models/late.py:3 reads apps.second.types.ROLE",
        "apps/first/models/records.py:1 imports apps.second",
        "apps/first/models/records.py:5 imports apps.second.services",
        "apps/second/models.py:1 imports apps.first.selectors",
    ], "the models check passed a models module that imports another application"


def test_the_boundary_check_names_a_module_importing_another_applications_models(
    tmp_path: Path,
) -> None:
    first = tmp_path / "apps" / "first"
    second = tmp_path / "apps" / "second"
    (first / "api").mkdir(parents=True)
    second.mkdir(parents=True)
    (first / "models.py").write_text("from apps.second.models import Thing\n", encoding="utf-8")
    (first / "services.py").write_text(
        "from .models import Own\nfrom apps.second.services import get_thing\n"
        "from apps.second.types import ROLE\n\n\n"
        "def late():\n    import apps.second.models\n",
        encoding="utf-8",
    )
    (first / "selectors.py").write_text("from ..second import models\n", encoding="utf-8")
    (first / "api" / "views.py").write_text(
        "from ...second.models import Thing\nfrom ..models import Own\n", encoding="utf-8"
    )
    (second / "models.py").write_text("from . import models\n", encoding="utf-8")
    # The models reached through a name an import bound, with no import statement naming them.
    (first / "through_package.py").write_text(
        "from apps import second\n\nTHING = second.models.Thing\n", encoding="utf-8"
    )
    (first / "through_root.py").write_text(
        "import apps.second.services\n\n\ndef late():\n    return apps.second.models.Thing\n",
        encoding="utf-8",
    )
    (first / "through_relative.py").write_text(
        "from .. import second as other\n\nTHING = other.models.Thing\n", encoding="utf-8"
    )
    # A name bound twice keeps both meanings: the later import does not hide the earlier one.
    (first / "through_rebound.py").write_text(
        "from apps import second as other\nimport json as other\n\nTHING = other.models.Thing\n",
        encoding="utf-8",
    )
    (first / "own.py").write_text(
        "from apps import first\nfrom apps.second import services\n\n"
        "OWN = first.models.Own\nTHING = services.get_thing\n",
        encoding="utf-8",
    )
    assert cross_application_model_imports(tmp_path) == [
        "apps/first/api/views.py:1 imports apps.second.models",
        "apps/first/models.py:1 imports apps.second.models",
        "apps/first/selectors.py:1 imports apps.second.models",
        "apps/first/services.py:7 imports apps.second.models",
        "apps/first/through_package.py:3 reads apps.second.models",
        "apps/first/through_rebound.py:4 reads apps.second.models",
        "apps/first/through_relative.py:3 reads apps.second.models",
        "apps/first/through_root.py:5 reads apps.second.models",
    ], "the boundary check passed a module that reaches another application's models"


def test_the_api_check_names_an_api_module_reaching_a_models_module_or_another_application(
    tmp_path: Path,
) -> None:
    first = tmp_path / "apps" / "first"
    (first / "api").mkdir(parents=True)
    (tmp_path / "apps" / "second" / "api").mkdir(parents=True)
    (first / "api" / "views.py").write_text(
        "from django.db import models\nfrom apps.first.services import read\n"
        "from apps.first.models import Own\nfrom ..selectors import by_id\n\n\n"
        "def late():\n    import apps.second.models.records\n"
        "    from apps.second.services import get_thing\n",
        encoding="utf-8",
    )
    (first / "api" / "serializers.py").write_text(
        "from .. import models\nfrom . import permissions\n", encoding="utf-8"
    )
    (first / "services.py").write_text("from .models import Own\n", encoding="utf-8")
    # What an api module may not reach, through a name an import bound, with no import statement
    # naming it: a models module, its own application's included, and another application.
    (tmp_path / "apps" / "second" / "api" / "views.py").write_text(
        "import apps.second.services\nfrom apps.first import selectors\n\n"
        "THING = apps.second.models.Thing\nOTHER = apps.first.services.read\n"
        "BY_ID = selectors.by_id\n",
        encoding="utf-8",
    )
    assert forbidden_api_imports(tmp_path) == [
        "apps/first/api/serializers.py:1 imports apps.first.models",
        "apps/first/api/views.py:3 imports apps.first.models",
        "apps/first/api/views.py:8 imports apps.second.models",
        "apps/first/api/views.py:9 imports apps.second",
        "apps/second/api/views.py:2 imports apps.first",
        "apps/second/api/views.py:4 reads apps.second.models",
        "apps/second/api/views.py:5 reads apps.first",
        "apps/second/api/views.py:6 reads apps.first",
    ], "the api check passed an api module that reaches a models module or another application"


def test_the_api_check_fails_when_it_reads_no_api_module(tmp_path: Path) -> None:
    (tmp_path / "apps" / "first").mkdir(parents=True)
    (tmp_path / "apps" / "first" / "models.py").write_text("", encoding="utf-8")
    assert forbidden_api_imports(tmp_path) == [
        "no module under apps/*/api/ other than __init__.py"
    ], "the api check passed a tree with no api module"
    # An api package that holds only its marker is no module to check either.
    (tmp_path / "apps" / "first" / "api").mkdir()
    (tmp_path / "apps" / "first" / "api" / "__init__.py").write_text("", encoding="utf-8")
    assert forbidden_api_imports(tmp_path) == [
        "no module under apps/*/api/ other than __init__.py"
    ], "the api check passed a tree whose api package holds only __init__.py"


def test_no_worker_module_imports_an_applications_models_or_api() -> None:
    assert worker_imports_of_models_or_api(ROOT) == [], (
        "a worker module imports an application's models or api"
    )


def test_the_worker_check_names_a_worker_module_importing_models_or_api(tmp_path: Path) -> None:
    (tmp_path / "worker").mkdir()
    (tmp_path / "worker" / "__init__.py").write_text("", encoding="utf-8")
    assert worker_imports_of_models_or_api(tmp_path) == [
        "no module under worker/ other than __init__.py"
    ]
    (tmp_path / "worker" / "steps.py").write_text(
        "from apps.jobs import services\nfrom apps.orgs.models import Organisation\n\n\n"
        "def late():\n    import apps.identity.api.views\n",
        encoding="utf-8",
    )
    assert worker_imports_of_models_or_api(tmp_path) == [
        "worker/steps.py:2 imports apps.orgs.models.Organisation",
        "worker/steps.py:6 imports apps.identity.api.views",
    ], "the worker check passed a worker module that imports models or api"


def test_the_core_check_names_a_core_module_importing_apps_or_worker(tmp_path: Path) -> None:
    (tmp_path / "core" / "db").mkdir(parents=True)
    (tmp_path / "core" / "health.py").write_text(
        "from django.db import connection\nfrom core.db.ids import new_uuid7\n"
        "import workers\nimport apps.identity.services\n",
        encoding="utf-8",
    )
    (tmp_path / "core" / "db" / "ids.py").write_text(
        "from .. import health\n\n\ndef late():\n    from worker.steps import run\n"
        "    from apps import identity\n",
        encoding="utf-8",
    )
    (tmp_path / "core" / "db" / "__init__.py").write_text("import worker as w\n", encoding="utf-8")
    assert core_imports_of_apps_or_worker(tmp_path) == [
        "core/db/__init__.py:1 imports worker",
        "core/db/ids.py:5 imports worker.steps.run",
        "core/db/ids.py:6 imports apps.identity",
        "core/health.py:4 imports apps.identity.services",
    ], "the core check passed a core module that imports apps or worker"


def test_the_core_check_fails_when_it_reads_no_core_module(tmp_path: Path) -> None:
    (tmp_path / "core").mkdir()
    assert core_imports_of_apps_or_worker(tmp_path) == [
        "no module under core/ other than __init__.py"
    ], "the core check passed a tree with no core module"
    (tmp_path / "core" / "db").mkdir()
    (tmp_path / "core" / "__init__.py").write_text("", encoding="utf-8")
    (tmp_path / "core" / "db" / "__init__.py").write_text("", encoding="utf-8")
    assert core_imports_of_apps_or_worker(tmp_path) == [
        "no module under core/ other than __init__.py"
    ], "the core check passed a tree whose core packages hold only __init__.py"


def forbidden_queue_imports(root: Path) -> list[str]:
    """Queue runtime cannot import test helpers; outbox reaches only the inert jobs flag API.

    Walk every static import, including function-local imports. Computed imports are not claimed.
    """
    found: set[tuple[str, int, str]] = set()
    for relative, package, owner, tree in _application_modules(root):
        if owner not in {"jobs", "outbox"}:
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Import | ast.ImportFrom):
                continue
            for name in _imported(node, package):
                if name.split(".")[0] in {"tests", "database_mutants"} or (
                    owner == "outbox"
                    and (name == "apps.jobs" or name.startswith("apps.jobs."))
                    and not (name == "apps.jobs.mutants" or name.startswith("apps.jobs.mutants."))
                ):
                    found.add((relative.as_posix(), node.lineno, name))
    return [f"{path}:{line} imports {name}" for path, line, name in sorted(found)]


def test_queue_imports_keep_test_helpers_and_job_types_out_of_outbox() -> None:
    assert forbidden_queue_imports(ROOT) == [], "queue runtime crosses a test or outbox boundary"


def test_queue_boundary_check_detects_module_and_function_local_imports(tmp_path: Path) -> None:
    jobs, outbox = tmp_path / "apps/jobs", tmp_path / "apps/outbox"
    jobs.mkdir(parents=True)
    outbox.mkdir(parents=True)
    (jobs / "services.py").write_text(
        "from tests.job_queue import database_mutants\n"
        "def late():\n    from database_mutants import snapshot_guards\n",
        encoding="utf-8",
    )
    (outbox / "services.py").write_text(
        "from apps.jobs.types import ReconciliationDecision\n"
        "def late():\n    from apps import jobs\n",
        encoding="utf-8",
    )
    assert forbidden_queue_imports(tmp_path) == [
        "apps/jobs/services.py:1 imports tests.job_queue.database_mutants",
        "apps/jobs/services.py:3 imports database_mutants.snapshot_guards",
        "apps/outbox/services.py:1 imports apps.jobs.types.ReconciliationDecision",
        "apps/outbox/services.py:3 imports apps.jobs",
    ], "the queue boundary check missed a module-level or late forbidden import"
    (jobs / "services.py").write_text("from apps.outbox import services\n", encoding="utf-8")
    (outbox / "services.py").write_text(
        "from core.db.ids import new_uuid7\nfrom apps.jobs import mutants\n", encoding="utf-8"
    )
    assert forbidden_queue_imports(tmp_path) == [], (
        "the queue boundary check refused allowed imports"
    )
