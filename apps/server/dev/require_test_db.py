"""Refuse to run the suite unless a Postgres server answers the test credentials.

`make test` and `make first-slice-scenarios` run this before pytest. The probe
it replaces opened a TCP connection to the test database port and accepted
whatever answered, so a foreign service on the port passed it and the suite
then failed on its first query. This one connects with the test database URL
and runs a trivial query, and refuses everything else with a message that says
what it found: nothing listening, a listener that is not Postgres, or a
Postgres server that rejects the credentials.

It never starts the container itself: `make test-db` under a shared compose
project name recreates another worktree's test-db.

Usage: require_test_db.py DATABASE_URL [--timeout SECONDS]
"""

from __future__ import annotations

import argparse
import math
import socket
import sys

import psycopg
from psycopg.conninfo import conninfo_to_dict

FIX = "Start it first: make test-db, with the same COMPOSE and CORE_TEST_DB_PORT."
DEFAULT_TIMEOUT = 5.0


def endpoint(url: str) -> tuple[str, int, str]:
    """The host, port and user the URL names, with libpq's defaults."""
    parts = conninfo_to_dict(url)
    return (
        str(parts.get("host") or "localhost"),
        int(parts.get("port") or 5432),
        str(parts.get("user") or ""),
    )


def libpq_reason(exc: BaseException) -> str:
    """libpq's whole message on one line.

    libpq puts the diagnostic on its first line and continues on indented
    lines: for a listener that accepts and closes, the last line alone is
    "before or while processing the request." and says nothing.
    """
    lines = [line.strip() for line in str(exc).splitlines() if line.strip()]
    return " ".join(lines) if lines else exc.__class__.__name__


def libpq_wait(timeout: float) -> int:
    """The seconds libpq actually waits for a connect_timeout of `timeout`.

    connect_timeout is whole seconds, and anything under 2 is raised to 2
    (psycopg.conninfo.timeout_from_conninfo applies libpq's floor), so a
    requested 1 s is really 2 s.
    """
    return max(2, math.ceil(timeout))


def probe(url: str, timeout: float = DEFAULT_TIMEOUT) -> str | None:
    """None when a Postgres server answers the URL, else the refusal to print."""
    host, port, user = endpoint(url)
    where = f"{host}:{port}"
    try:
        socket.create_connection((host, port), timeout=timeout).close()
    except OSError as exc:
        reason = exc.strerror or str(exc)
        return f"No test database accepts connections on {where} ({reason}).\n{FIX}"
    wait = libpq_wait(timeout)
    try:
        with psycopg.connect(
            url, connect_timeout=wait, application_name="require-test-db"
        ) as connection:
            row = connection.execute("SELECT 1").fetchone()
    except psycopg.errors.ConnectionTimeout:
        return (
            f"Something accepts connections on {where} but did not answer as a Postgres "
            f"server within {wait} s: it is not the test database.\n{FIX}"
        )
    except psycopg.OperationalError as exc:
        return (
            f"Something accepts connections on {where} but is not a Postgres server "
            f"answering the test credentials (user {user}): {libpq_reason(exc)}\n{FIX}"
        )
    if row != (1,):
        return f"The Postgres server on {where} answered SELECT 1 with {row!r}.\n{FIX}"
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[1])
    parser.add_argument("url", help="the test database URL, as make test passes it")
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT,
        help="seconds per step; the Postgres step waits at least 2 whole seconds, as libpq does",
    )
    args = parser.parse_args(argv)
    refusal = probe(args.url, args.timeout)
    if refusal is not None:
        print(refusal, file=sys.stderr)
        return 1
    host, port, _ = endpoint(args.url)
    print(f"Test database answers on {host}:{port}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
