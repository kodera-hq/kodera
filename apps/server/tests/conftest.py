"""Raise PostgreSQL `statement_timeout` around test-harness `flush` and DB teardown only.

Application and request-level `statement_timeout` bounds remain untouched during every test body;
only Django `TransactionTestCase._fixture_teardown` (`TRUNCATE` across ~75 tables) and session
`DROP DATABASE` teardown temporarily apply a 60s ceiling so runner I/O spikes never cancel cleanup.
"""

from __future__ import annotations

import contextlib
import os
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import pytest
from django.db import DatabaseError, connections
from django.test.testcases import TransactionTestCase


@contextmanager
def _teardown_statement_timeout(timeout: str = "60s") -> Iterator[None]:
    saved: list[tuple[Any, str, str]] = []
    for conn in connections.all():
        if conn.connection is None or conn.in_atomic_block:
            continue
        try:
            with conn.cursor() as cursor:
                cursor.execute("SHOW statement_timeout")
                row_stmt = cursor.fetchone()
                prev_stmt = str(row_stmt[0]) if row_stmt else "2s"
                cursor.execute("SHOW lock_timeout")
                row_lock = cursor.fetchone()
                prev_lock = str(row_lock[0]) if row_lock else "5s"
                cursor.execute("SET statement_timeout = %s", [timeout])
                cursor.execute("SET lock_timeout = %s", [timeout])
                saved.append((conn, prev_stmt, prev_lock))
        except (DatabaseError, OSError):
            continue
    try:
        yield
    finally:
        for conn, prev_stmt, prev_lock in saved:
            if conn.connection is None or conn.in_atomic_block:
                continue
            try:
                with conn.cursor() as cursor:
                    cursor.execute("SET statement_timeout = %s", [prev_stmt])
                    cursor.execute("SET lock_timeout = %s", [prev_lock])
            except (DatabaseError, OSError):
                continue


_ORIGINAL_FIXTURE_TEARDOWN = TransactionTestCase._fixture_teardown


def _hardened_fixture_teardown(self: TransactionTestCase) -> None:
    # Ensure default test connection is open in autocommit so `SET statement_timeout = '60s'`
    # governs the `flush` TRUNCATE batch, then restores the 2s application budget immediately.
    for db_name in self._databases_names(include_mirrors=False):
        conn = connections[db_name]
        if conn.connection is None:
            with contextlib.suppress(DatabaseError, OSError):
                conn.ensure_connection()
    with _teardown_statement_timeout("60s"):
        _ORIGINAL_FIXTURE_TEARDOWN(self)


TransactionTestCase._fixture_teardown = _hardened_fixture_teardown  # type: ignore[method-assign]


@pytest.fixture(scope="session")
def django_db_modify_db_settings(django_db_modify_db_settings: None) -> None:
    """Allow isolated parallel lanes to target `test_<POSTGRES_DB>` without sharing one test DB."""
    custom_db = os.environ.get("POSTGRES_DB", "").strip()
    if custom_db and custom_db != "kodera_server":
        for conn in connections.all():
            conn.settings_dict.setdefault("TEST", {})["NAME"] = f"test_{custom_db}"


@pytest.fixture(scope="session")
def django_db_setup(django_db_setup: None) -> Iterator[None]:
    """Raise `statement_timeout` to 60s for final session `DROP DATABASE` teardown."""
    yield
    for conn in connections.all():
        options = conn.settings_dict.setdefault("OPTIONS", {})
        options["options"] = f"{options.get('options', '')} -c statement_timeout=60000".strip()
