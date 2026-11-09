"""Assert the queue's isolation precondition in each transaction, including caller savepoints."""

from collections.abc import Iterator
from contextlib import contextmanager

from django.db import connection, transaction
from django.db.transaction import TransactionManagementError

from . import mutants


@contextmanager
def queue_atomic(function: str) -> Iterator[None]:
    """Never change caller isolation or reuse a check from another transaction/connection."""
    with transaction.atomic():
        if not mutants.on("isolation_unchecked"):
            with connection.cursor() as cursor:
                cursor.execute("SHOW transaction_isolation")
                level = cursor.fetchone()[0]
            if level != "read committed":
                raise TransactionManagementError(
                    f"{function} requires READ COMMITTED (JOB_QUEUE.md §4); actual={level}"
                )
        yield
