"""One JSON line per log record, on stderr, for the API profiles' `LOGGING` (config/settings/base.py).

Without it, an uncaught exception in a view answered 500 and wrote nothing: Django's own console
handler logs only with `DEBUG` on, and no profile turns it on.

What a line carries is an allow-list, so the never-logged list of the logging policy holds by
construction rather than by scrubbing:

- the record's message *template* as its event, never its arguments (a failed request's event is
  `request.failed`): an argument is the usual way a value a
  caller controls, or personal data, reaches a log line;
- for a request, its method, the route pattern it matched and the response status, never the path,
  the query string, a header or the body (an unmatched path is caller-chosen text);
- for an exception, its type and its frames (file, line, function, source line), for each exception
  in its chain, never its message: an exception message carries its arguments, a database error
  the row's values.
"""

from __future__ import annotations

import json
import logging
import traceback
from datetime import UTC, datetime
from typing import Any


def _exception(error: BaseException) -> list[dict[str, Any]]:
    """The chain, earliest first as Python prints it: each exception's type and frames."""
    chain: list[dict[str, Any]] = []
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        chain.append(
            {
                "type": _type_name(type(current)),
                "frames": [
                    {"file": f.filename, "line": f.lineno, "function": f.name, "code": f.line}
                    for f in traceback.extract_tb(current.__traceback__)
                ],
            }
        )
        current = current.__cause__ or (
            None if current.__suppress_context__ else current.__context__
        )
    chain.reverse()
    return chain


def _type_name(exc_type: type[BaseException]) -> str:
    module = exc_type.__module__
    return exc_type.__qualname__ if module == "builtins" else f"{module}.{exc_type.__qualname__}"


class JsonLine(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        line: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, UTC)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            "level": record.levelname,
            "logger": record.name,
            "event": str(record.msg),
        }
        status = getattr(record, "status_code", None)
        if status is not None:
            # Django's `log_response`, whose template is "%s: %s" (reason and path).
            line["event"] = "request.failed"
            line["status"] = status
        request = getattr(record, "request", None)
        if request is not None:
            match = getattr(request, "resolver_match", None)
            line["method"] = getattr(request, "method", None)
            line["route"] = match.route if match is not None else None
        if record.exc_info and record.exc_info[1] is not None:
            line["exception"] = _exception(record.exc_info[1])
        return json.dumps(line, ensure_ascii=False, default=str)
