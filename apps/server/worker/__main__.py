"""`python -m worker run`: the provisioning worker. `python -m worker check`: its boundary, verified.

Both enter the accident guard (worker/boot.py; not a sandbox) before anything else is imported,
then start Django on `config.settings.deploy_worker`, then verify the boundary from inside: the
guard refuses an ordinary bind and listen, no URL configuration, WSGI application or middleware is set, and no URL, WSGI
or API module is loaded. `check` prints that verification and exits. `run` then holds its
database budget to its lease (worker/runner.py), reaches its database and serves the production
registry's kinds until SIGTERM. That registry binds no kind before G1.5-C, so today `run` says so
and stops, rather than idling as if it ran a job.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
from typing import Any

from worker import boot

# Loaded modules that would give the worker an HTTP surface.
HTTP_MODULE_PARTS = ("urls", "wsgi", "asgi", "gunicorn")


def _refused(probe: Any) -> str:
    try:
        probe()
    except boot.BoundaryRefusal:
        return "refused"
    return "admitted"


def _bind() -> None:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))


def _listen() -> None:
    with socket.socket() as probe:
        probe.listen()


def _raw_listen() -> None:
    import _socket

    probe = _socket.socket()
    try:
        probe.listen(1)
    finally:
        probe.close()


def _http_modules() -> list[str]:
    found = []
    for name in sorted(sys.modules):
        parts = name.split(".")
        first_party = parts[0] in {"config", "core", "apps", "services", "worker"}
        if first_party and (
            "api" in parts
            or any(part.endswith(HTTP_MODULE_PARTS) for part in parts)
            or name == "core.health"
        ):
            found.append(name)
    return found


def verify() -> dict[str, Any]:
    """The boundary as this process holds it; raises SystemExit if any part of it is open."""
    from django.conf import settings

    import worker.credentials

    report = {
        "settings": os.environ["DJANGO_SETTINGS_MODULE"],
        "bind": _refused(_bind),
        "listen": _refused(_listen),
        "raw_listen": _refused(_raw_listen),
        "root_urlconf": settings.ROOT_URLCONF,
        "wsgi_application": settings.WSGI_APPLICATION,
        "middleware": list(settings.MIDDLEWARE),
        "debug": settings.DEBUG,
        "http_modules": _http_modules(),
        "credentials": worker.credentials.__name__,
    }
    held: dict[str, Any] = {
        "bind": "refused",
        "listen": "refused",
        "raw_listen": "refused",
        "root_urlconf": None,
        "wsgi_application": None,
        "middleware": [],
        "debug": False,
        "http_modules": [],
    }
    open_parts = sorted(key for key, value in held.items() if report[key] != value)
    if open_parts:
        raise SystemExit("the worker boundary is open: " + ", ".join(open_parts))
    return report


def _reach_database() -> None:
    from django.db import connection
    from django.db.utils import Error

    try:
        connection.ensure_connection()
    except Error:
        # The driver's message can carry the host and user; the operator reads the database's log.
        raise SystemExit("the worker cannot reach its database") from None
    finally:
        connection.close()


def main(argv: list[str] | None = None) -> int:
    boot.enter()
    parser = argparse.ArgumentParser(prog="python -m worker")
    parser.add_argument("command", choices=("run", "check"))
    command = parser.parse_args(argv).command
    boot.select_settings(os.environ)

    import django

    django.setup()
    report = verify()
    if command == "check":
        print(json.dumps(report))
        return 0
    from django.db import connection

    from worker import runner
    from worker.registry import PRODUCTION

    refused = runner.database_budget_refusals(connection.settings_dict.get("OPTIONS", {}))
    if refused:
        raise SystemExit("; ".join(refused))
    _reach_database()
    print(json.dumps({"worker": "started", "database": "reachable"}), file=sys.stderr)
    if not PRODUCTION.kinds:
        raise SystemExit(runner.NO_KIND_SERVED)
    # G1.5-C's wiring point: the production provider and credential source are bound here, with
    # the kinds PRODUCTION serves. `provider=None` is refused by Runner for any served kind.
    return _serve(
        runner.Runner(runner_id=f"worker-{os.getpid()}", registry=PRODUCTION, provider=None)
    )


def _serve(served: Any) -> int:
    """Serve until SIGTERM; crash-only, restarted by the container's policy (worker/runner.py)."""
    import signal
    import threading

    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    served.serve(stop)
    return 0


if __name__ == "__main__":
    sys.exit(main())
