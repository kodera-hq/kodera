"""What a routed view declares about the contract operations it serves: docs/api/AUTHZ.md §5.

A view names, per HTTP method, the operation of contracts/core-api.openapi.yaml it serves and that
operation's `x-kodera-scope`. tests/architecture/test_view_scopes.py fails on a routed view
without a declaration, on a scope that is not a §5 row and verb, and on a scope, method or path
that differs from the contract's.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import TypeVar

ATTRIBUTE = "declared_operations"

View = TypeVar("View")


@dataclass(frozen=True)
class Operation:
    """One contract operation: its HTTP method, its operationId and its `x-kodera-scope`."""

    method: str
    operation_id: str
    scope: str


def declares(*operations: Operation) -> Callable[[View], View]:
    """Mark a view, function or class, with the operations it serves.

    Apply it outermost. A decorator outside it that builds a new view, such as DRF's `api_view`,
    drops the mark, and the view then fails the test as a view without a scope. One built with
    `functools.wraps` copies the mark to its wrapper, so the test does not see what it adds.
    """

    def mark(view: View) -> View:
        setattr(view, ATTRIBUTE, operations)
        return view

    return mark
