"""dev/require_test_db.py refuses what is not the test database, by message and exit status.

The probe it replaced accepted any TCP listener on the port. Each fixture here
is one way the port can be wrong, and each refusal must name what was found:
a check that fails with the right message for the wrong reason proves nothing.
"""

import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from django.db import connection

ROOT = Path(__file__).resolve().parents[1]
PROBE = ROOT / "dev/require_test_db.py"
FIX = "Start it first: make test-db, with the same COMPOSE and CORE_TEST_DB_PORT."


def run_probe(url, *args):
    return subprocess.run(  # noqa: S603 - fixed local CLI
        [sys.executable, str(PROBE), url, *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
        env={**os.environ},
        timeout=60,
    )


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class Listener:
    """A loopback TCP listener that is anything but Postgres."""

    def __init__(self, reply):
        self.reply = reply
        self.stop = threading.Event()
        self.socket = socket.socket()
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.socket.bind(("127.0.0.1", 0))
        self.socket.listen()
        self.socket.settimeout(0.1)
        self.port = self.socket.getsockname()[1]
        self.held = []
        self.thread = threading.Thread(target=self.serve, daemon=True)

    def serve(self):
        while not self.stop.is_set():
            try:
                client, _ = self.socket.accept()
            except TimeoutError:
                continue
            if self.reply is None:
                self.held.append(client)  # never answers, like an HTTP server waiting for a line
            else:
                client.sendall(self.reply)
                client.close()
        for client in self.held:
            client.close()
        self.socket.close()

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.stop.set()
        self.thread.join()


def suite_database_url(**overrides):
    settings = {**connection.settings_dict, **overrides}
    return (
        f"postgres://{settings['USER']}:{settings['PASSWORD']}"
        f"@{settings['HOST']}:{settings['PORT']}/{settings['NAME']}"
    )


@pytest.mark.django_db
def test_the_real_test_database_passes():
    process = run_probe(suite_database_url())
    assert process.returncode == 0, process.stderr
    assert process.stdout.startswith("Test database answers on ")
    assert process.stderr == ""


def test_a_closed_port_is_refused_as_nothing_listening():
    port = free_port()
    process = run_probe(f"postgres://kodera:kodera@127.0.0.1:{port}/kodera_server")
    assert process.returncode == 1
    assert process.stdout == ""
    assert process.stderr.startswith(f"No test database accepts connections on 127.0.0.1:{port} (")
    assert FIX in process.stderr


def test_a_listener_that_is_not_postgres_is_refused_by_what_it_answered():
    # The old probe passed here: something accepted the TCP connection.
    with Listener(b"HTTP/1.0 400 Bad Request\r\n\r\n") as listener:
        process = run_probe(f"postgres://kodera:kodera@127.0.0.1:{listener.port}/kodera_server")
    assert process.returncode == 1
    assert process.stdout == ""
    assert process.stderr.startswith(
        f"Something accepts connections on 127.0.0.1:{listener.port} but is not a Postgres "
        "server answering the test credentials (user kodera): "
    )
    assert "invalid response" in process.stderr
    assert FIX in process.stderr


def test_a_listener_that_accepts_then_closes_is_refused_by_libpqs_whole_diagnostic():
    # libpq spreads this refusal over three lines, and the diagnostic is on the
    # first: "server closed the connection unexpectedly". The last line alone,
    # "before or while processing the request.", names nothing.
    with Listener(b"") as listener:
        process = run_probe(f"postgres://kodera:kodera@127.0.0.1:{listener.port}/kodera_server")
    assert process.returncode == 1
    assert process.stdout == ""
    assert process.stderr.startswith(
        f"Something accepts connections on 127.0.0.1:{listener.port} but is not a Postgres "
        "server answering the test credentials (user kodera): "
    )
    assert "server closed the connection unexpectedly" in process.stderr
    assert "before or while processing the request." in process.stderr
    assert process.stderr.count("\n") == 2, "libpq's message is joined onto the refusal's line"
    assert FIX in process.stderr


@pytest.mark.slow
def test_a_silent_listener_is_refused_after_the_wait_libpq_really_took():
    # `python3 -m http.server` on the port behaves like this: it waits for a
    # request line that a Postgres client never sends. libpq's floor for
    # connect_timeout is 2 s, so `--timeout 1` waits 2 s and the refusal must
    # say 2, not the 1 it was asked for; this is the one case that takes that long.
    with Listener(None) as listener:
        started = time.monotonic()
        process = run_probe(
            f"postgres://kodera:kodera@127.0.0.1:{listener.port}/kodera_server",
            "--timeout",
            "1",
        )
        elapsed = time.monotonic() - started
    assert process.returncode == 1
    assert process.stdout == ""
    assert process.stderr.startswith(
        f"Something accepts connections on 127.0.0.1:{listener.port} but did not answer as a "
        "Postgres server within 2 s: it is not the test database."
    )
    assert elapsed >= 2, f"the probe claims a 2 s wait but returned after {elapsed:.2f} s"
    assert FIX in process.stderr


@pytest.mark.django_db
def test_a_postgres_that_rejects_the_credentials_is_refused_by_its_own_fatal():
    process = run_probe(suite_database_url(USER="not-the-test-user", PASSWORD="not-the-password"))
    assert process.returncode == 1
    assert process.stdout == ""
    assert process.stderr.startswith(
        f"Something accepts connections on {connection.settings_dict['HOST']}:"
        f"{connection.settings_dict['PORT']} but is not a Postgres server answering the test "
        "credentials (user not-the-test-user): "
    )
    assert "FATAL" in process.stderr and '"not-the-test-user"' in process.stderr
    assert FIX in process.stderr
