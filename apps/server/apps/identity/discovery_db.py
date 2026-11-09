"""Discovery-owned transactions with one shrinking elapsed database budget."""

import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any, NoReturn

from django.db import DatabaseError, connection, transaction
from psycopg import capabilities

from services.identity.discovery_policy import DiscoveryUnavailableError, QuotaDecision


def _refuse(reason: str, *, quota: QuotaDecision | None = None) -> NoReturn:
    # A contextmanager generator is resumed with the caller's active exception.
    # Clear its implicit chain after construction, before the same safe error is reraised.
    try:
        raise DiscoveryUnavailableError(reason, quota=quota)
    except DiscoveryUnavailableError as error:
        error.__context__ = None
        error.__cause__ = None
        raise


class Deadline:
    def __init__(self, *, seconds: float = 2) -> None:
        if seconds > 2:
            _refuse("database-budget")
        self.end = time.monotonic() + seconds

    def check(self) -> None:
        if time.monotonic() >= self.end:
            _refuse("database-budget")

    def execute(self, execute: Any, sql: str, params: Any, many: bool, context: Any) -> Any:
        self.check()
        milliseconds = max(1, int((self.end - time.monotonic()) * 1000))
        execute(
            "SELECT set_config('statement_timeout', %s, true), "
            "set_config('lock_timeout', %s, true)",
            [f"{milliseconds}ms", f"{milliseconds}ms"],
            False,
            context,
        )
        self.check()
        result = execute(sql, params, many, context)
        self.check()
        return result


@contextmanager
def _cancel_at_deadline(deadline: Deadline) -> Iterator[None]:
    """Hold one raw session; no replacement can inherit a delayed cancellation."""
    raw = connection.connection
    if (
        raw is None
        or not capabilities.has_cancel_safe()
        or not callable(getattr(raw, "cancel_safe", None))
    ):
        _refuse("database-cancellation")
    fired, cancellation_failed = threading.Event(), threading.Event()

    def cancel() -> None:
        fired.set()
        try:
            raw.cancel_safe(timeout=0.5)
        except Exception:
            cancellation_failed.set()

    timer = threading.Timer(max(0, deadline.end - time.monotonic()), cancel)
    timer.name = "kodera-discovery-db-deadline"
    timer.start()
    caught: BaseException | None = None
    try:
        yield
    except BaseException as error:
        # Raise safe refusals only after leaving the original exception context.
        caught = error
    timer.cancel()
    timer.join(timeout=1)
    incomplete = timer.is_alive()
    if fired.is_set() or incomplete or time.monotonic() >= deadline.end:
        try:
            if connection.connection is raw:
                connection.close()
            else:
                raw.close()
        except Exception:
            incomplete = True
    if incomplete:
        caught = None
        _refuse("database-cancellation-incomplete")
    if cancellation_failed.is_set():
        caught = None
        _refuse("database-cancellation")
    if fired.is_set() and caught is None:
        _refuse("database-budget")
    if isinstance(caught, DatabaseError):
        caught = None
        _refuse("database")
    if isinstance(caught, DiscoveryUnavailableError):
        reason, quota = caught.reason, caught.quota
        caught = None
        _refuse(reason, quota=quota)
    if caught is not None:
        raise caught
    deadline.check()


@contextmanager
def discovery_transaction(deadline: Deadline, *, read_only: bool = False) -> Iterator[None]:
    deadline.check()
    if connection.vendor != "postgresql" or connection.in_atomic_block:
        _refuse("transaction-context")
    failed = False
    try:
        if not connection.get_autocommit():
            _refuse("transaction-context")
        deadline.check()
        with _cancel_at_deadline(deadline), transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute(
                    "SET TRANSACTION ISOLATION LEVEL "
                    + ("REPEATABLE READ READ ONLY" if read_only else "READ COMMITTED")
                )
            with connection.execute_wrapper(deadline.execute):
                yield
                deadline.check()
                # Refresh immediately before COMMIT; the connection watchdog remains active
                # across setup, commit and acknowledgement, not only ORM statements.
                remaining = max(1, int((deadline.end - time.monotonic()) * 1000))
                with connection.cursor() as cursor:
                    cursor.execute(
                        "SELECT set_config('statement_timeout', %s, true)", [f"{remaining}ms"]
                    )
        # A late or uncertain commit must not return a successful admission/selection.
        deadline.check()
    except DatabaseError:
        failed = True
    if failed:
        _refuse("database")
