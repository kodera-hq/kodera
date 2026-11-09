"""The job-queue acceptance inventory, `acceptance.toml`, read and refused whole if malformed, and
the checks that bind it and `mutants.toml` to the acceptance module and the specification.

Kept apart from the conftest so the self-test imports it by a name no other conftest shares.
"""

from __future__ import annotations

import ast
import re
import tomllib
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from queue_harness import (
    GAP_PATTERN,
    HERE,
    ID_PATTERN,
    INVENTORY_PATH,
    MARKER,
    QueueGapError,
    RealBinding,
    gap_is_missing,
)

ACCEPTANCE_MODULE = "test_job_queue_acceptance.py"
SELFTEST_MODULE = "test_job_queue_selftest.py"
# The one file an honest gap is raised from: `unwrap` and `RealBinding.require` live there.
HARNESS_PATH = HERE / "queue_harness.py"
STATES = {"xfail", "pass"}
BINDINGS = ("permissive", "inert")
PROPERTY_PATTERN = re.compile(r"JQ-P\d{2}")


class InventoryError(ValueError):
    pass


def load_inventory(text: str) -> dict[str, dict[str, Any]]:
    """The inventory, refused whole if any row is malformed: a row that cannot be read binds nothing."""
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
        if row["state"] == "xfail" and (not isinstance(gap, str) or not GAP_PATTERN.fullmatch(gap)):
            raise InventoryError(f"{identifier} is xfail with no well-formed gap")
        if row["state"] == "pass" and gap is not None:
            raise InventoryError(f"{identifier} passes and still records gap {gap!r}")
        if not str(row.get("function", "")).startswith("test_a3_"):
            raise InventoryError(f"{identifier} names no acceptance function")
        for binding in BINDINGS:
            if not isinstance(row.get(binding), str) or not row[binding].strip():
                raise InventoryError(
                    f"{identifier} names no assertion the {binding} queue must fail"
                )
        rows[identifier] = row
    if not rows:
        raise InventoryError("the inventory has no test")
    return rows


try:
    INVENTORY = load_inventory(INVENTORY_PATH.read_text(encoding="utf-8"))
except InventoryError as error:
    raise pytest.UsageError(f"job-queue inventory {INVENTORY_PATH}: {error}") from None


def verdict(
    row: dict[str, Any],
    *,
    when: str,
    outcome: str,
    wasxfail: str | None,
    error: BaseException | None,
    origin: str | None = None,
    measure: Callable[[str], bool] = gap_is_missing,
) -> str | None:
    """Why an `xfail` row's report is refused, or None when it is exactly the expected failure.

    The only accepted shape: setup and teardown pass, and the call raises exactly `QueueGapError`
    with the row's gap, reported as an expected failure that ran; the gap is one of the harness's
    closed list, was raised by the harness's own gap probe — `origin`, the file of the innermost
    frame, is `queue_harness.py` — and not while another exception was being handled; and the gap,
    measured again, is still missing from this tree.
    """
    name = row["id"]
    if when != "call":
        if outcome == "failed" or (outcome == "skipped" and wasxfail is not None):
            return f"{name} failed in {when}: only the test body may reach the gap"
        if outcome == "skipped":
            return f"{name} skipped in {when}, which no inventory state allows"
        return None
    if outcome == "passed":
        return f"{name} passed while the inventory records gap {row['gap']}"
    if outcome == "failed":
        return None
    if wasxfail is None:
        return f"{name} skipped, which no inventory state allows"
    if "[NOTRUN]" in wasxfail:
        return f"{name} was not run ([NOTRUN]), which no inventory state allows"
    if type(error) is not QueueGapError:
        kind = "no exception" if error is None else type(error).__name__
        return f"{name} was an expected failure on {kind}, not exactly QueueGapError"
    if error.gap != row["gap"]:
        return (
            f"{name} is red at gap {error.gap}, not the recorded {row['gap']}: move the "
            "inventory row with the change that moved the gap"
        )
    if error.gap not in RealBinding.gaps():
        return (
            f"{name} is bound to gap {error.gap}, which the harness never raises: no honest test "
            "reaches it"
        )
    handled = error.__context__ or error.__cause__
    if handled is not None:
        return (
            f"{name} raised its gap while handling {type(handled).__name__}: a failure relabelled "
            "as a gap"
        )
    if origin is None or Path(origin).resolve() != HARNESS_PATH.resolve():
        source = "nowhere" if origin is None else Path(origin).name
        return f"{name} raised its gap from {source}, not from the harness's gap probe"
    if not measure(row["gap"]):
        return (
            f"{name} raised gap {row['gap']}, which this tree provides when measured again: the "
            "gap was not the reason it failed"
        )
    return None


def pass_verdict(
    row: dict[str, Any], *, when: str, outcome: str, wasxfail: str | None
) -> str | None:
    """Why a `pass` row's report is refused: in no phase may it be skipped or excused."""
    if outcome != "skipped":
        return None
    excused = "an expected failure" if wasxfail is not None else "skipped"
    return f"{row['id']} is a pass row and was {excused} in {when}"


@dataclass(frozen=True)
class Assertion:
    """One assertion message of a test: whether it always runs with the test and can fail it, and
    why what it tests could never be false or true for a reason of the queue's."""

    reachable: bool
    vacuous: str | None


LEAVING = (ast.Return, ast.Raise, ast.Continue, ast.Break)
LEAVING_CALLS = {"skip", "xfail", "fail", "exit", "importorskip"}
SWALLOWED_WITH = {"AssertionError", "Exception", "BaseException"}


def _names(node: ast.expr | None) -> set[str]:
    if node is None:
        return set()
    return {found.id for found in ast.walk(node) if isinstance(found, ast.Name)} | {
        found.attr for found in ast.walk(node) if isinstance(found, ast.Attribute)
    }


def _leaves(statement: ast.stmt) -> bool:
    """A statement after which the rest of its body never runs: `return`, `raise`, a loop exit, or
    a call that leaves the test such as `pytest.skip(...)`."""
    if isinstance(statement, LEAVING):
        return True
    if isinstance(statement, ast.With | ast.AsyncWith):
        return any(_leaves(inner) for inner in statement.body)
    if isinstance(statement, ast.Try | ast.TryStar):
        return any(_leaves(inner) for inner in [*statement.body, *statement.finalbody])
    if not (isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Call)):
        return False
    called = statement.value.func
    return (
        isinstance(called, ast.Attribute)
        and isinstance(called.value, ast.Name)
        and called.value.id == "pytest"
        and called.attr in LEAVING_CALLS
    )


def _swallows(statement: ast.stmt) -> bool:
    """A `with suppress(...)`, a `with pytest.raises(...)` or a `try` whose handler would catch the
    `AssertionError` of an assert in its body, so that assert can never fail the test."""
    if isinstance(statement, ast.With | ast.AsyncWith):
        for item in statement.items:
            call = item.context_expr
            if not isinstance(call, ast.Call) or not _names(call.func) & {"suppress", "raises"}:
                continue
            if any(_names(argument) & SWALLOWED_WITH for argument in call.args):
                return True
        return False
    if isinstance(statement, ast.Try | ast.TryStar):
        return any(
            handler.type is None or bool(_names(handler.type) & SWALLOWED_WITH)
            for handler in statement.handlers
        )
    return False


def _statements(body: list[ast.stmt], reachable: bool) -> Iterator[tuple[ast.stmt, bool]]:
    """Every statement of a body, and whether it runs, and can fail the test, whenever the body runs.

    A `with` body and a `try` body or `finally` always run; a branch, a loop, an exception handler,
    an `else` and a nested function or class may not. Nothing runs after a statement that leaves the
    body, and an assert whose `AssertionError` is swallowed cannot fail anything.
    """
    for statement in body:
        yield statement, reachable
        if isinstance(statement, ast.With | ast.AsyncWith):
            yield from _statements(statement.body, reachable and not _swallows(statement))
        elif isinstance(statement, ast.Try | ast.TryStar):
            yield from _statements(statement.body, reachable and not _swallows(statement))
            yield from _statements(statement.finalbody, reachable)
            yield from _statements(statement.orelse, False)
            for handler in statement.handlers:
                yield from _statements(handler.body, False)
        elif isinstance(statement, ast.Match):
            for case in statement.cases:
                yield from _statements(case.body, False)
        else:
            for name in ("body", "orelse"):
                nested = getattr(statement, name, None)
                if isinstance(nested, list):
                    yield from _statements(nested, False)
        if _leaves(statement):
            reachable = False


def _vacuous(test: ast.expr, fixtures: set[str]) -> str | None:
    """Why an assert's test says nothing about the queue, or None when it reads something."""
    reads = (ast.Name, ast.Attribute, ast.Call, ast.Subscript, ast.Await, ast.NamedExpr)
    if not any(isinstance(node, reads) for node in ast.walk(test)):
        return "tests a constant"
    if isinstance(test, ast.Name) and test.id in fixtures:
        return "tests only a fixture, which is always true"
    return None


def assertion_messages(source: str) -> dict[str, dict[str, Assertion]]:
    """For each acceptance test, by identifier, the assertion messages written verbatim in its body.

    Read from the syntax tree, so a message is a whole string literal of an `assert`, never a piece
    of one, and an f-string is not a message a mutant row can name. A message is reachable when some
    `assert` carrying it is a statement the test always runs and that can fail it, and vacuous only
    when every such `assert` tests constants or a bare fixture.
    """
    found: dict[str, dict[str, Assertion]] = {}
    for node in ast.parse(source).body:
        if not isinstance(node, ast.FunctionDef):
            continue
        identifier = None
        for decorator in node.decorator_list:
            if (
                isinstance(decorator, ast.Call)
                and isinstance(decorator.func, ast.Name)
                and decorator.func.id == MARKER
                and decorator.args
                and isinstance(decorator.args[0], ast.Constant)
            ):
                identifier = str(decorator.args[0].value)
        if identifier is None:
            continue
        fixtures = {argument.arg for argument in node.args.args}
        messages: dict[str, Assertion] = {}
        for statement, reachable in _statements(node.body, True):
            if not (
                isinstance(statement, ast.Assert)
                and isinstance(statement.msg, ast.Constant)
                and isinstance(statement.msg.value, str)
            ):
                continue
            vacuous = _vacuous(statement.test, fixtures)
            before = messages.get(statement.msg.value)
            if before is None or (reachable and vacuous is None):
                messages[statement.msg.value] = Assertion(reachable, vacuous)
        found[identifier] = messages
    return found


def mutant_refusals(mutants_text: str, acceptance_source: str, spec_text: str) -> list[str]:
    """Everything wrong with `mutants.toml` against the acceptance module and the specification.

    Textual and structural only: it shows each row names an assertion of an owning test that always
    runs, can fail and reads something, never that a mutant is caught (docs/specs/JOB_QUEUE.md §9.1
    and §9.2).
    """
    data = tomllib.loads(mutants_text)
    if data.get("format") != 1:
        return ["mutants.toml: format must be 1"]
    rows = data.get("mutant", [])
    properties = data.get("property", {})
    messages = assertion_messages(acceptance_source)
    refusals: list[str] = []
    flags: set[str] = set()
    named: dict[str, str] = {}
    for row in rows:
        flag = str(row.get("flag", ""))
        test = str(row.get("test", ""))
        message = str(row.get("message", ""))
        prop = str(row.get("property", ""))
        if not flag or flag in flags:
            refusals.append(f"flag {flag!r} is empty or appears twice")
        flags.add(flag)
        if PROPERTY_PATTERN.fullmatch(prop) is None:
            refusals.append(f"{flag}: property {prop!r} is not a JQ-Pnn identifier")
        elif test not in properties.get(prop, {}).get("tests", []):
            refusals.append(f"{flag}: its test {test} is not an owning test of {prop}")
        if not str(row.get("mutant", "")).strip():
            refusals.append(f"{flag}: says nothing of what the mutant does")
        if message in named:
            refusals.append(f"{flag}: its message is also named by {named[message]}")
        named.setdefault(message, flag)
        if test not in messages:
            refusals.append(
                f"{flag}: its owning test {test} does not exist in the acceptance module"
            )
        elif message not in messages[test]:
            refusals.append(
                f"{flag}: its message is not an assertion message written verbatim in {test}"
            )
        elif not messages[test][message].reachable:
            refusals.append(
                f"{flag}: its message is asserted in {test} only where the test may not run it"
            )
        elif messages[test][message].vacuous is not None:
            refusals.append(f"{flag}: its assertion in {test} {messages[test][message].vacuous}")
        owners = sorted(owner for owner, found in messages.items() if message in found)
        if len(owners) > 1:
            refusals.append(
                f"{flag}: its message is an assertion message of {len(owners)} tests: "
                + ", ".join(owners)
            )
    listed = set(PROPERTY_PATTERN.findall(spec_text))
    covered = {str(row.get("property", "")) for row in rows}
    refusals.extend(
        f"property {missing} of the specification has no mutant row"
        for missing in sorted(listed - covered)
    )
    refusals.extend(
        f"mutant rows name property {extra}, which the specification does not list"
        for extra in sorted(covered - listed)
    )
    for prop, entry in sorted(properties.items()):
        if prop not in listed:
            refusals.append(
                f"mutants.toml owns property {prop}, which the specification does not list"
            )
        for test in entry.get("tests", []):
            if test not in messages:
                refusals.append(f"property {prop} names owning test {test}, which does not exist")
            elif not any(row.get("property") == prop and row.get("test") == test for row in rows):
                refusals.append(
                    f"property {prop} names owning test {test}, which no row of it uses"
                )
    refusals.extend(
        f"property {missing} of the specification names no owning test"
        for missing in sorted(listed - set(properties))
    )
    return refusals
