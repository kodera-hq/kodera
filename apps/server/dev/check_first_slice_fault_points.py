#!/usr/bin/env python3
"""Hold the tree to the first-slice fault-point inventory, `tests/first_slice/fault_points.toml`.

Read from source only, never imported, so it runs with no settings and no database:

- core/faults.py's SITES and POINTS are exactly the inventory's sites and points, and its
  `SimulatedCrash` derives from BaseException alone, so no `except Exception` swallows a crash;
- each site has exactly one `faults.reach("<site>")` in Core, in the file and function the
  inventory names, after the call it must follow; no reach names anything else;
- every name a scenario arms with `h.fault_point(...)` is a recorded point or planned name, and the
  scenarios that arm each are exactly the ones the inventory lists; a planned name Core declares is
  refused, so it moves to the points the day it lands.

`dev/mutate_first_slice_fault_points.py` proves each rule can fail.
"""

from __future__ import annotations

import argparse
import ast
import itertools
import json
import sys
import tomllib
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
INVENTORY = Path("tests/first_slice/fault_points.toml")
FAULTS = Path("core/faults.py")
SCENARIOS = Path("tests/first_slice")
# Core's source: where a reach() may be. Tests and dev tooling are not Core.
CORE_SOURCE = ("apps", "config", "core", "room_access", "services", "tenant_agent", "worker")
WILDCARD = "*"


@dataclass(frozen=True)
class Reach:
    file: str
    line: int
    function: str
    site: str | None
    follows_ok: dict[str, bool]


def load_inventory(path: Path) -> dict[str, Any]:
    with path.open("rb") as handle:
        value = tomllib.load(handle)
    if not isinstance(value, dict) or value.get("format") != 1:
        raise ValueError(f"{path} is not a format 1 fault-point inventory")
    return value


def planned_matches(planned: str, name: str) -> bool:
    """Whether a run-time name fills a planned name: `*` stands for one non-empty segment."""
    wanted, given = planned.split(":"), name.split(":")
    return len(wanted) == len(given) and all(
        w == g or (w == WILDCARD and g != "") for w, g in zip(wanted, given, strict=True)
    )


# ------------------------------------------------------------------------- core/faults.py ----


def declared(source: str) -> tuple[list[str], dict[str, tuple[str, str]], list[str]]:
    """The sites, POINTS as name -> (site, mode), and SimulatedCrash's base names, read from
    source. The sites are POINTS' own, in order: core/faults.py derives SITES the same way."""
    tree = ast.parse(source)
    points: dict[str, tuple[str, str]] = {}
    bases: list[str] = []
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
            if isinstance(target, ast.Name) and target.id == "POINTS":
                mapping = node.value
                if isinstance(mapping, ast.Call) and mapping.args:
                    mapping = mapping.args[0]
                if isinstance(mapping, ast.Dict):
                    for key, value in zip(mapping.keys, mapping.values, strict=True):
                        if isinstance(value, ast.Call) and key is not None:
                            site, mode = (ast.literal_eval(arg) for arg in value.args)
                            points[str(ast.literal_eval(key))] = (str(site), str(mode))
        if isinstance(node, ast.ClassDef) and node.name == "SimulatedCrash":
            bases = [ast.unparse(base) for base in node.bases]
    return list(dict.fromkeys(site for site, _ in points.values())), points, bases


# ------------------------------------------------------------------------ reach() sites ----


def _own(node: ast.AST) -> Iterator[ast.AST]:
    """The nodes of a function's own body: not those of a nested function, class or lambda."""
    for child in ast.iter_child_nodes(node):
        yield child
        if not isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            yield from _own(child)


def _is_reach(node: ast.AST) -> bool:
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "reach"
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "faults"
    )


def _callee(node: ast.Call) -> str:
    return ast.unparse(node.func)


IMPORT_AS = "imports core.faults other than as `from core import faults`"


def _hidden_reaches(tree: ast.AST, relative: str) -> list[str]:  # noqa: C901 - one rule per branch
    """Every way of reaching a site this check would not see as one: core.faults bound under
    another name, reach imported or looked up by name, or faults.reach used but not called."""
    problems: list[str] = []
    called = {id(node.func) for node in ast.walk(tree) if isinstance(node, ast.Call)}
    for node in ast.walk(tree):
        line = getattr(node, "lineno", 0)
        if isinstance(node, ast.ImportFrom) and node.module == "core.faults":
            if {alias.name for alias in node.names} & {"reach", "*"}:
                problems.append(
                    f"{relative}:{line} imports reach from core.faults; call it as faults.reach "
                    "so the check can see the site"
                )
        elif isinstance(node, ast.ImportFrom) and node.module == "core":
            if any(
                a.name in ("faults", "*") and a.asname not in (None, "faults") for a in node.names
            ):
                problems.append(f"{relative}:{line} {IMPORT_AS}")
        elif isinstance(node, ast.Import):
            if any(alias.name == "core.faults" for alias in node.names):
                problems.append(f"{relative}:{line} {IMPORT_AS}")
        elif (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in ("getattr", "vars")
            and any(isinstance(arg, ast.Constant) and arg.value == "reach" for arg in node.args[1:])
        ):
            problems.append(f"{relative}:{line} looks reach up by name")
        elif isinstance(node, ast.Attribute) and node.attr == "reach":
            owner = ast.unparse(node.value)
            if owner != "faults" and owner.endswith("faults"):
                problems.append(f"{relative}:{line} calls reach through {owner}, not faults.reach")
            elif owner == "faults" and id(node) not in called:
                problems.append(
                    f"{relative}:{line} refers to faults.reach other than by calling it"
                )
    return problems


def reaches(root: Path, follows: dict[str, str]) -> tuple[list[Reach], list[str]]:
    """Every faults.reach() in Core's source, and the problems reading them raised."""
    found: list[Reach] = []
    problems: list[str] = []
    for top in CORE_SOURCE:
        for path in sorted((root / top).rglob("*.py")):
            relative = path.relative_to(root).as_posix()
            tree = ast.parse(path.read_text(encoding="utf-8"))
            problems.extend(_hidden_reaches(tree, relative))

            def visit(scope: ast.AST, qualname: str, relative: str = relative) -> None:
                for node in _own(scope):
                    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                        visit(node, f"{qualname}.{node.name}" if qualname else node.name)
                    elif isinstance(node, ast.Lambda):
                        visit(node, f"{qualname}.<lambda>" if qualname else "<lambda>")
                    elif isinstance(node, ast.Call) and _is_reach(node):
                        site = None
                        if (
                            len(node.args) == 1
                            and not node.keywords
                            and isinstance(node.args[0], ast.Constant)
                            and isinstance(node.args[0].value, str)
                        ):
                            site = node.args[0].value
                        else:
                            problems.append(
                                f"{relative}:{node.lineno} calls faults.reach() with something "
                                "other than one string literal"
                            )
                        calls = [
                            other
                            for other in _own(scope)
                            if isinstance(other, ast.Call) and other is not node
                        ]
                        # A call that has returned before the reach: it ends on an earlier line.
                        follows_ok = {
                            wanted: any(
                                _callee(other) in (wanted,) or _callee(other).endswith("." + wanted)
                                for other in calls
                                if (other.end_lineno or other.lineno) < node.lineno
                            )
                            for wanted in set(follows.values())
                        }
                        found.append(Reach(relative, node.lineno, qualname, site, follows_ok))

            visit(tree, "")
    return found, problems


# ------------------------------------------------------------------------ scenario uses ----


def _constants(node: ast.AST | None) -> list[str] | None:
    if isinstance(node, (ast.Tuple, ast.List)) and all(
        isinstance(item, ast.Constant) and isinstance(item.value, str) for item in node.elts
    ):
        return [str(item.value) for item in node.elts if isinstance(item, ast.Constant)]
    return None


def _values(function: ast.AST, name: str) -> list[str] | None:
    """The strings `name` takes in `function`: a loop over a literal tuple, directly, through a
    name bound to one, or as the second target of `enumerate(...)` over one."""
    assigned: dict[str, list[str]] = {}
    for node in _own(function):
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
            values = _constants(node.value)
            if isinstance(target, ast.Name) and values is not None:
                assigned[target.id] = values

    def iterable(node: ast.AST) -> list[str] | None:
        if isinstance(node, ast.Name):
            return assigned.get(node.id)
        return _constants(node)

    for node in _own(function):
        if not isinstance(node, ast.For):
            continue
        if isinstance(node.target, ast.Name) and node.target.id == name:
            return iterable(node.iter)
        if (
            isinstance(node.target, ast.Tuple)
            and len(node.target.elts) == 2
            and isinstance(node.target.elts[1], ast.Name)
            and node.target.elts[1].id == name
            and isinstance(node.iter, ast.Call)
            and ast.unparse(node.iter.func) == "enumerate"
            and len(node.iter.args) == 1
        ):
            return iterable(node.iter.args[0])
    return None


def _names(function: ast.AST, argument: ast.AST) -> list[str] | None:
    if isinstance(argument, ast.Constant) and isinstance(argument.value, str):
        return [argument.value]
    if isinstance(argument, ast.Name):
        return _values(function, argument.id)
    if isinstance(argument, ast.JoinedStr):
        parts: list[list[str]] = []
        for part in argument.values:
            if isinstance(part, ast.Constant):
                parts.append([str(part.value)])
            elif isinstance(part, ast.FormattedValue) and isinstance(part.value, ast.Name):
                parts.append(_values(function, part.value.id) or [WILDCARD])
            else:
                parts.append([WILDCARD])
        return ["".join(combination) for combination in itertools.product(*parts)]
    return None


def _is_fault_point(node: ast.AST) -> bool:
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "fault_point"
    )


def scenario_uses(root: Path) -> tuple[dict[str, set[str]], list[str]]:
    """name -> the first-slice scenarios or real-worker tests that arm it, with read failures."""
    uses: dict[str, set[str]] = {}
    problems: list[str] = []
    for path in sorted((root / SCENARIOS).glob("test_fs_*.py")):
        relative = path.relative_to(root).as_posix()
        tree = ast.parse(path.read_text(encoding="utf-8"))
        attributed: set[int] = set()
        for function in tree.body:
            if not isinstance(function, ast.FunctionDef):
                continue
            ids = [
                decorator.args[0].value
                for decorator in function.decorator_list
                if isinstance(decorator, ast.Call)
                and ast.unparse(decorator.func) == "scenario"
                and decorator.args
                and isinstance(decorator.args[0], ast.Constant)
            ]
            if len(ids) != 1:
                continue
            scenario_id = str(ids[0])
            for node in ast.walk(function):
                if not _is_fault_point(node):
                    continue
                assert isinstance(node, ast.Call)  # noqa: S101 - narrowed by _is_fault_point
                attributed.add(id(node))
                if len(node.args) != 1 or node.keywords:
                    problems.append(
                        f"{relative}:{node.lineno} arms a fault point with arguments the check "
                        "cannot read"
                    )
                    continue
                names = _names(function, node.args[0])
                if names is None:
                    problems.append(
                        f"{scenario_id} arms a fault point the check cannot name: "
                        f"{ast.unparse(node.args[0])}"
                    )
                    continue
                for name in names:
                    uses.setdefault(name, set()).add(scenario_id)
        for node in ast.walk(tree):
            if _is_fault_point(node) and id(node) not in attributed:
                problems.append(
                    f"{relative}:{getattr(node, 'lineno', 0)} arms a fault point outside a scenario"
                )
    # Real-worker kills arm the same gated points through Control, outside first-slice scenarios.
    # Require literal names and bind each use to its collected test function, just as above.
    for path in sorted((root / "tests/worker").glob("test_*.py")):
        relative = path.relative_to(root).as_posix()
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for function in tree.body:
            if not isinstance(function, ast.FunctionDef):
                continue
            for node in ast.walk(function):
                if not (
                    isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Attribute)
                    and node.func.attr == "arm"
                ):
                    continue
                if not (
                    len(node.args) == 2
                    and not node.keywords
                    and isinstance(node.args[0], ast.Constant)
                    and isinstance(node.args[0].value, str)
                ):
                    problems.append(
                        f"{relative}:{node.lineno} arms a worker fault point the check cannot name"
                    )
                    continue
                uses.setdefault(node.args[0].value, set()).add(f"{relative}::{function.name}")
    return uses, problems


# -------------------------------------------------------------------------------- audit ----


def audit(root: Path = ROOT) -> list[str]:  # noqa: C901, PLR0912 - one rule per branch
    """Every disagreement between the tree and the fault-point inventory, in a stable order."""
    problems: list[str] = []
    inventory = load_inventory(root / INVENTORY)
    sites = {str(row["name"]): row for row in inventory.get("site", [])}
    points = {str(row["name"]): row for row in inventory.get("point", [])}
    planned = {str(row["name"]): row for row in inventory.get("planned", [])}
    recorded = [str(row["name"]) for key in ("point", "planned") for row in inventory.get(key, [])]
    for name in sorted({name for name in recorded if recorded.count(name) > 1}):
        problems.append(f"{name} is recorded more than once in the inventory")

    core_sites, core_points, bases = declared((root / FAULTS).read_text(encoding="utf-8"))
    if bases != ["BaseException"]:
        problems.append(
            f"core/faults.py: SimulatedCrash derives from {', '.join(bases) or 'nothing'}, not "
            "from BaseException alone, so an `except Exception` in Core swallows a simulated crash"
        )
    for site in core_sites:
        if site not in sites:
            problems.append(f"site {site} is declared by core/faults.py but not in the inventory")
    for site in sites:
        if site not in core_sites:
            problems.append(f"inventory site {site} is not declared by core/faults.py")
    for name, (site, mode) in core_points.items():
        row = points.get(name)
        if row is None:
            problems.append(
                f"fault point {name} is declared by core/faults.py but not in the inventory"
            )
        elif (row.get("site"), row.get("mode")) != (site, mode):
            problems.append(
                f"fault point {name}: the inventory records ({row.get('site')}, {row.get('mode')}) "
                f"and core/faults.py declares ({site}, {mode})"
            )
    for name in points:
        if name not in core_points:
            problems.append(f"inventory point {name} is not declared by core/faults.py")
    for name, row in points.items():
        alias = row.get("alias_of")
        if alias is not None and points.get(alias, {}).get("site") != row.get("site"):
            problems.append(f"alias {name} names {alias}, which is not a point on its site")
    for name in planned:
        if name in core_points:
            problems.append(
                f"planned fault point {name} is declared by core/faults.py: record it as a point"
            )

    follows = {name: str(row.get("follows", "")) for name, row in sites.items()}
    found, reach_problems = reaches(root, follows)
    problems += reach_problems
    for reach in found:
        if reach.site is not None and reach.site not in core_sites:
            problems.append(
                f"{reach.file}:{reach.line} reaches {reach.site!r}, which core/faults.py does not "
                "declare as a site"
            )
    for site, row in sites.items():
        at = [reach for reach in found if reach.site == site]
        if len(at) != 1:
            problems.append(
                f"site {site} has {len(at)} faults.reach() calls in Core; it must have exactly one"
            )
            continue
        reach = at[0]
        if (reach.file, reach.function) != (row.get("file"), row.get("function")):
            problems.append(
                f"site {site} is reached in {reach.file}:{reach.function}, and the inventory "
                f"places it in {row.get('file')}:{row.get('function')}"
            )
        elif row.get("follows") and not reach.follows_ok.get(str(row["follows"]), False):
            problems.append(
                f"site {site} is reached in {reach.function} before {row['follows']} returns there"
            )

    uses, use_problems = scenario_uses(root)
    problems += use_problems
    for name in sorted(uses):
        if name not in points and name not in planned:
            problems.append(
                f"{', '.join(sorted(uses[name]))} arms {name}, which the fault-point inventory "
                "does not record"
            )
    for name, row in {**points, **planned}.items():
        listed = sorted(str(item) for item in row.get("scenarios", []))
        actual = sorted(uses.get(name, set()))
        if not listed:
            problems.append(f"fault point {name} lists no scenario that arms it")
        elif listed != actual:
            problems.append(
                f"fault point {name}: the inventory records it armed by {', '.join(listed)}, and "
                f"the scenarios arm it in {', '.join(actual) or 'none'}"
            )
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    arguments = parser.parse_args(argv)
    try:
        problems = audit(arguments.root)
    except (OSError, ValueError, SyntaxError, tomllib.TOMLDecodeError) as error:
        problems = [
            f"the fault-point inventory or tree is unreadable: {type(error).__name__}: {error}"
        ]
    if problems:
        print(json.dumps({"format": 1, "status": "refused", "problems": problems}, indent=2))
        return 1
    print(json.dumps({"format": 1, "status": "consistent"}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
