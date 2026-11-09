"""The Agent API's command loop for `engine_set_member_subjects` and `engine_set_channel_members`
(contracts/agent-api.openapi.yaml 0.5.0).

getCommands answers immediately and never holds a connection or a worker (ADR-0018), with a
`poll_after_s` hint of 3, and serves this application's kinds only. The instance is the
credential's, never a parameter.
"""

import json
import re
from typing import Any
from uuid import UUID

from django.http import HttpRequest, HttpResponse

from apps.engine_intents.services import (
    CommandConflictError,
    CommandNotFoundError,
    InvalidResultError,
    acknowledge,
    authenticate,
    pull,
    report,
)
from core.api.scopes import declares
from core.db.ids import new_uuid7

from .permissions import ACK_COMMAND, GET_COMMANDS, REPORT_COMMAND_RESULT

PROBLEM_BASE = "https://kodera.io/problems/"
PROBLEMS = {
    400: ("validation-failed", "Validation failed"),
    401: ("unauthenticated", "Authentication required"),
    404: ("not-found", "Not found"),
    405: ("method-not-allowed", "Method not allowed"),
    409: ("conflict", "Conflict"),
}
KNOWN_KINDS = frozenset(
    {
        "start",
        "stop",
        "maintenance",
        "render",
        "upgrade",
        "backup",
        "restore",
        "preflight",
        "rotate",
        "self_update",
        "decommission",
        "engine_set_member_subjects",
        "engine_set_channel_members",
    }
)
REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{8,64}\Z")
MAX_BODY = 16 * 1024


def _request_id(request: HttpRequest) -> str:
    supplied = request.headers.get("X-Request-Id", "")
    return supplied if REQUEST_ID.fullmatch(supplied) else str(new_uuid7())


def _json(status: int, body: dict[str, Any], request_id: str) -> HttpResponse:
    response = HttpResponse(json.dumps(body), status=status, content_type="application/json")
    response["X-Request-Id"] = request_id
    return response


def _problem(status: int, request_id: str, allow: str = "") -> HttpResponse:
    kind, title = PROBLEMS[status]
    body = {"type": PROBLEM_BASE + kind, "title": title, "status": status, "request_id": request_id}
    response = HttpResponse(
        json.dumps(body), status=status, content_type="application/problem+json"
    )
    response["X-Request-Id"] = request_id
    if status == 401:
        response["WWW-Authenticate"] = "Bearer"
    if allow:
        response["Allow"] = allow
    return response


def _credential(request: HttpRequest) -> Any:
    header = request.headers.get("Authorization", "")
    return authenticate(header[7:]) if header.startswith("Bearer ") else None


def _body(request: HttpRequest) -> dict[str, Any] | None:
    if len(request.body) > MAX_BODY:
        return None
    try:
        body = json.loads(request.body or b"{}")
    except ValueError:
        return None
    return body if isinstance(body, dict) else None


@declares(GET_COMMANDS)
def commands(request: HttpRequest) -> HttpResponse:
    request_id = _request_id(request)
    if request.method != "GET":
        return _problem(405, request_id, allow="GET")
    credential = _credential(request)
    if credential is None:
        return _problem(401, request_id)
    try:
        limit = int(request.GET.get("max", "5"))
        wait_s = int(request.GET.get("wait_s", "0"))
    except ValueError:
        return _problem(400, request_id)
    raw_kinds = request.GET.get("kinds")
    kinds = tuple(k for k in raw_kinds.split(",") if k) if raw_kinds is not None else None
    if not 1 <= limit <= 20 or not 0 <= wait_s <= 55 or (kinds and not set(kinds) <= KNOWN_KINDS):
        return _problem(400, request_id)
    pulled = pull(credential, kinds=kinds, limit=limit)
    body = {
        "commands": pulled.commands,
        "visibility_timeout_s": pulled.visibility_timeout_s,
        "poll_after_s": pulled.poll_after_s,
    }
    return _json(200, body, request_id)


@declares(ACK_COMMAND)
def ack(request: HttpRequest, command_id: UUID) -> HttpResponse:
    request_id = _request_id(request)
    if request.method != "POST":
        return _problem(405, request_id, allow="POST")
    credential = _credential(request)
    if credential is None:
        return _problem(401, request_id)
    body = _body(request)
    if body is None or not isinstance(body.get("accepted_at"), str):
        return _problem(400, request_id)
    boot_id = body.get("boot_id")
    if boot_id is not None and (not isinstance(boot_id, str) or not 1 <= len(boot_id) <= 64):
        return _problem(400, request_id)
    try:
        answer = acknowledge(credential, command_id, boot_id=boot_id)
    except CommandNotFoundError:
        return _problem(404, request_id)
    except CommandConflictError:
        return _problem(409, request_id)
    return _json(200, answer, request_id)


@declares(REPORT_COMMAND_RESULT)
def result(request: HttpRequest, command_id: UUID) -> HttpResponse:
    request_id = _request_id(request)
    if request.method != "POST":
        return _problem(405, request_id, allow="POST")
    credential = _credential(request)
    if credential is None:
        return _problem(401, request_id)
    body = _body(request)
    if (
        body is None
        or body.get("command_id") != str(command_id)
        or not isinstance(body.get("reported_at"), str)
    ):
        return _problem(400, request_id)
    try:
        recorded, status = report(credential, command_id, body)
    except InvalidResultError:
        return _problem(400, request_id)
    except CommandNotFoundError:
        return _problem(404, request_id)
    except CommandConflictError:
        return _problem(409, request_id)
    return _json(
        200, {"command_id": str(command_id), "recorded": recorded, "status": status}, request_id
    )
