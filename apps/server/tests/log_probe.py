"""Run by tests/test_error_log.py in its own process: the settings' LOGGING as Django applies it.

Usage: python tests/log_probe.py [mutation]. Before Django starts, the mutation weakens one clause
of LOGGING or of core.logs.JsonLine; then the probe makes four records and its stderr is the result:

1. a POST whose view raises, carrying a secret in its query, body, Authorization header, cookie,
   path and in each exception message of a chain of two: a 500;
2. a GET of an unmatched path carrying a secret: a 404;
3. a warning with a secret argument, from a logger made before Django configured logging, as a
   module imported by the settings makes one;
4. an INFO record from a `django` logger, which logs INFO to its parents.
"""

from __future__ import annotations

import importlib
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

SECRET = "s3cr3t-probe-value"
# In each exception message; the source lines a frame carries name only the constant.
MESSAGE = f"bob@example.com {SECRET}"
ITEM = "6f1c1c2e-2a59-4f39-9a59-5f1f8f3a5b10"

early = logging.getLogger("apps.probe")


def _weaken(mutation: str) -> None:
    from core import logs

    settings = importlib.import_module(os.environ["DJANGO_SETTINGS_MODULE"])
    config: dict[str, Any] = settings.LOGGING
    handler = config["handlers"]["stderr"]
    original = logs.JsonLine.format

    def with_field(name: str, value: Any) -> None:
        def format(self: logs.JsonLine, record: logging.LogRecord) -> str:
            line = json.loads(original(self, record))
            line[name] = value(record)
            return json.dumps(line)

        logs.JsonLine.format = format  # type: ignore[method-assign]

    if mutation == "no-logging":
        del settings.LOGGING
    elif mutation == "no-root-handler":
        config["root"]["handlers"] = []
    elif mutation == "handler-level-notset":
        del handler["level"]
    elif mutation == "handler-level-error":
        handler["level"] = "ERROR"
    elif mutation == "request-at-warning":
        del config["loggers"]["django.request"]
    elif mutation == "existing-loggers-disabled":
        config["disable_existing_loggers"] = True
    elif mutation == "plain-formatter":
        del config["handlers"]["stderr"]["formatter"]
    elif mutation == "not-json":

        def unparsable(self: logs.JsonLine, record: logging.LogRecord) -> str:
            return original(self, record)[1:]

        logs.JsonLine.format = unparsable  # type: ignore[method-assign]
    elif mutation == "message-interpolated":
        with_field("event", lambda record: record.getMessage())
    elif mutation == "exception-message":
        with_field("error", lambda record: str(record.exc_info[1]) if record.exc_info else None)
    elif mutation == "path-logged":
        with_field(
            "path",
            lambda record: record.request.get_full_path() if hasattr(record, "request") else None,
        )
    elif mutation == "authorization-logged":
        with_field(
            "authorization",
            lambda record: (
                record.request.headers.get("Authorization") if hasattr(record, "request") else None
            ),
        )
    elif mutation:
        raise SystemExit(f"unknown mutation {mutation}")


def explode(request: Any, item: Any) -> Any:
    try:
        raise KeyError(SECRET)
    except KeyError as inner:
        raise RuntimeError(MESSAGE) from inner


def main(mutation: str) -> None:
    _weaken(mutation)
    import django

    django.setup()
    from django.test import Client
    from django.test.utils import override_settings, setup_test_environment
    from django.urls import path
    from rest_framework.decorators import api_view, authentication_classes, permission_classes
    from rest_framework.permissions import AllowAny

    view = api_view(["POST"])(authentication_classes([])(permission_classes([AllowAny])(explode)))
    sys.modules[__name__].urlpatterns = [  # type: ignore[attr-defined]
        path("probe/<uuid:item>/explode", view)
    ]
    setup_test_environment()
    client = Client(raise_request_exception=False)
    with override_settings(ROOT_URLCONF=__name__):
        client.cookies["sessionid"] = SECRET
        client.post(
            f"/probe/{ITEM}/explode?access_token={SECRET}",
            {"token": SECRET},
            content_type="application/json",
            headers={"Authorization": f"Bearer {SECRET}"},
        )
        client.get(f"/nowhere/{SECRET}")
    early.warning("probe.warned %s", SECRET)
    logging.getLogger("django.probe").info("probe.info")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "")
