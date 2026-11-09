"""The structure administration's ten operations: docs/specs/ESPACE_STRUCTURE.md §3.

Every view authenticates the bearer token against the trust configuration and refuses a staff
token, recording it, before any read: staff hold no cell of the Workspace row (AUTHZ.md §5). A
write is then authorised against current state in a snapshot of its own (`authorise`), and only
then runs: a `POST` through the replay store, whose step takes the workspace in a savepoint so that
a refused change stores its `4xx` with nothing else; a `PATCH` or a `DELETE` in a transaction of
its own. A refused tenant write is recorded as `authz.denied` (AUTHZ.md §9); a refused tenant read
is not, so a reader cannot fill the audit trail by repeating it.
"""

import json
import logging
from collections.abc import Callable
from typing import Any
from uuid import UUID

from django.conf import settings
from django.core.exceptions import RequestDataTooBig
from django.db import transaction
from django.http import HttpRequest, HttpResponse
from django.utils.http import parse_etags

from apps.workspaces.administration import (
    ACT_SCOPE,
    ACTIVE,
    ARCHIVED,
    CREATE_SCOPE,
    DELETE_SCOPE,
    READ_SCOPE,
    UPDATE_SCOPE,
    Administration,
    AdministrationForbiddenError,
    CategoryRow,
    ChannelRow,
    StructureMalformedError,
    StructureRefusal,
    WorkspaceBusyError,
    Write,
    authorise,
    begin,
    busy,
    create_category,
    create_channel,
    delete_category,
    parse,
    patch_category,
    patch_channel,
    read_administration,
    record_tenant_denial,
    set_lifecycle,
    tag,
)
from apps.workspaces.channel_access import change_access, read_access
from apps.workspaces.initialise import record_staff_denial
from apps.workspaces.structure import (
    WorkspaceCallerUnknownError,
    WorkspaceNotFoundError,
    WorkspaceUnavailableError,
)
from core.api import lanes, problems
from core.api.idempotency import StoredResponse, respond_once
from core.api.scopes import Operation, declares
from services.identity.access_tokens import TokenVerificationError, VerifiedAccessToken
from services.identity.trusted_issuers import verify_configured_token

from . import responses
from .permissions import (
    ARCHIVE_CHANNEL,
    CREATE_CATEGORY,
    CREATE_CHANNEL,
    DELETE_CATEGORY,
    GET_CHANNEL_ACCESS,
    GET_WORKSPACE_ADMINISTRATION,
    PATCH_CATEGORY,
    PATCH_CHANNEL,
    PATCH_CHANNEL_ACCESS,
    UNARCHIVE_CHANNEL,
)

LOG = logging.getLogger(__name__)
PATCH_MEDIA_TYPE = "application/merge-patch+json"
Handler = Callable[[HttpRequest, VerifiedAccessToken, str], HttpResponse]


def _stored(kind: str, request_id: str, extensions: dict[str, object]) -> StoredResponse:
    status, body = responses.document(kind, request_id, extensions)
    return StoredResponse(status=status, body=body, content_type=responses.PROBLEM_TYPE)


def _refusal(refused: StructureRefusal, request_id: str) -> HttpResponse:
    extensions = refused.extensions()
    response = responses.problem(refused.kind, request_id, **extensions)
    if "current_etag" in extensions:
        response["ETag"] = str(extensions["current_etag"])
    return response


def _body(request: HttpRequest) -> bytes:
    try:
        return request.body
    except RequestDataTooBig:
        raise StructureMalformedError() from None


def _encode(value: dict[str, Any]) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _json(value: dict[str, Any], etag: str | None) -> HttpResponse:
    response = HttpResponse(_encode(value), content_type="application/json")
    if etag is not None:
        response["ETag"] = etag
    return response


# --- representations --------------------------------------------------------------------------


def _category(row: CategoryRow) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "name": row.name,
        "template_key": row.template_key,
        "position": row.position,
        "etag": row.etag,
    }


def _channel(row: ChannelRow) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "category_id": None if row.category_id is None else str(row.category_id),
        "kind": row.kind,
        "name": row.name,
        "template_key": row.template_key,
        "topic": row.topic,
        "position": row.position,
        "lifecycle": row.lifecycle,
        "room_state": row.room_state,
        "access": {"mode": row.policy_mode},
        "etag": row.etag,
    }


def _administration(view: Administration) -> dict[str, Any]:
    return {
        "organisation_id": str(view.organisation_id),
        "id": str(view.workspace_id),
        "categories": [
            {**_category(item.category), "channels": [_channel(c) for c in item.channels]}
            for item in view.categories
        ],
        "uncategorised_channels": [_channel(c) for c in view.uncategorised_channels],
    }


# --- the shared frame -------------------------------------------------------------------------


def _serve(
    request: HttpRequest,
    organisation_id: UUID,
    operations: tuple[Operation, ...],
    handlers: dict[str, tuple[str, Handler]],
) -> HttpResponse:
    request_id = responses.request_id(request)
    method = request.method or ""
    scope = handlers[method][0] if method in handlers else READ_SCOPE
    try:
        if method not in handlers:
            response = responses.problem("method-not-allowed", request_id, allowed=list(handlers))
            response["Allow"] = ", ".join(handlers)
        else:
            verified, lane = verify_configured_token(
                responses.bearer(request), trusted=settings.KODERA_AUTH_TRUST
            )
            verified, lane = lanes.admit(verified, lane)
            if lane == "staff":
                # AUTHZ.md §9: a staff read refused is recorded as well as a staff write.
                record_staff_denial(
                    verified=verified,
                    organisation_id=organisation_id,
                    request_id=request_id,
                    required_scope=scope,
                )
                response = responses.problem("forbidden", request_id)
            else:
                response = handlers[method][1](request, verified, request_id)
    except TokenVerificationError:
        response = responses.problem("unauthenticated", request_id)
    except WorkspaceCallerUnknownError:
        operation = next(o for o in operations if o.method == method)
        response = problems.identity_unknown(request_id, operation.operation_id)
    except WorkspaceNotFoundError:
        response = responses.problem("not-found", request_id)
    except AdministrationForbiddenError as refused:
        response = responses.problem("forbidden", request_id)
        try:
            if method != "GET":
                record_tenant_denial(refused=refused, scope=scope, request_id=request_id)
        except Exception as failure:
            # AUTHZ.md §9: a refusal that cannot be recorded is not answered as recorded.
            LOG.error(
                "structure denial record failed: %s request_id=%s",
                type(failure).__name__,
                request_id,
            )
            response = responses.problem("internal-error", request_id)
    except StructureRefusal as refused:
        response = _refusal(refused, request_id)
    except (WorkspaceBusyError, WorkspaceUnavailableError):
        # Busy: another structural write holds the workspace. Unavailable: a stored row a read
        # relies on is missing or out of its vocabulary, which is never guessed (structure.py).
        response = responses.problem(
            "service-unavailable", request_id, retry_after_s=responses.RETRY_AFTER_S
        )
    except Exception as failure:
        if busy(failure):
            response = responses.problem(
                "service-unavailable", request_id, retry_after_s=responses.RETRY_AFTER_S
            )
        else:
            # SQL diagnostics, credentials, names and topics never enter the body or the log:
            # the log names the exception's class and the request id, nothing of the request.
            LOG.error(
                "structure %s failed: %s request_id=%s",
                method,
                type(failure).__name__,
                request_id,
            )
            response = responses.problem("internal-error", request_id)
    return responses.finish(response, request_id)


Act = Callable[[Write, dict[str, Any]], tuple[int, dict[str, Any], str]]


def _once(
    request: HttpRequest,
    verified: VerifiedAccessToken,
    request_id: str,
    organisation_id: UUID,
    act: Act,
    *,
    takes_body: bool,
    creating: bool = False,
) -> HttpResponse:
    """A `POST`: authorised first, then run once per key by the replay store. The step takes the
    workspace in a savepoint, so a refusal stores its `4xx` and nothing else."""
    authorise(verified=verified, organisation_id=organisation_id)

    def step() -> StoredResponse:
        try:
            content = _body(request)
            if takes_body:
                body = parse(content)
            elif content:
                raise StructureMalformedError()
            else:
                body = {}
            with transaction.atomic():
                write = begin(
                    verified=verified,
                    organisation_id=organisation_id,
                    request_id=request_id,
                    creating=creating,
                )
                status, rendered, etag = act(write, body)
        except WorkspaceNotFoundError:
            return _stored("not-found", request_id, {})
        except StructureRefusal as refused:
            return _stored(refused.kind, request_id, refused.extensions())
        return StoredResponse(
            status=status, body=_encode(rendered), content_type="application/json", etag=etag
        )

    return respond_once(
        request,
        issuer=verified.issuer,
        subject=verified.subject,
        request_id=request_id,
        handler=step,
    )


def _patched(
    request: HttpRequest,
    verified: VerifiedAccessToken,
    request_id: str,
    organisation_id: UUID,
    act: Callable[[Write, dict[str, Any], str | None], tuple[dict[str, Any], str]],
) -> HttpResponse:
    """A `PATCH`: authorised, then the merge patch applied in a transaction of its own."""
    authorise(verified=verified, organisation_id=organisation_id)
    media_type = request.headers.get("Content-Type", "").split(";")[0].strip()
    if media_type.lower() != PATCH_MEDIA_TYPE:
        raise StructureMalformedError()
    body = parse(_body(request))
    with transaction.atomic():
        write = begin(verified=verified, organisation_id=organisation_id, request_id=request_id)
        rendered, etag = act(write, body, request.headers.get("If-Match"))
    return _json(rendered, etag)


# --- the views --------------------------------------------------------------------------------


@declares(CREATE_CATEGORY)
def categories(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    def act(write: Write, body: dict[str, Any]) -> tuple[int, dict[str, Any], str]:
        row = create_category(write=write, body=body)
        return 201, _category(row), row.etag

    return _serve(
        request,
        organisation_id,
        (CREATE_CATEGORY,),
        {
            "POST": (
                CREATE_SCOPE,
                lambda r, v, i: _once(
                    r, v, i, organisation_id, act, takes_body=True, creating=True
                ),
            )
        },
    )


@declares(PATCH_CATEGORY, DELETE_CATEGORY)
def category(request: HttpRequest, organisation_id: UUID, category_id: UUID) -> HttpResponse:
    def patch(
        write: Write, body: dict[str, Any], if_match: str | None
    ) -> tuple[dict[str, Any], str]:
        row = patch_category(write=write, category_id=category_id, body=body, if_match=if_match)
        return _category(row), row.etag

    def delete(r: HttpRequest, v: VerifiedAccessToken, i: str) -> HttpResponse:
        authorise(verified=v, organisation_id=organisation_id)
        if _body(r):
            raise StructureMalformedError()
        with transaction.atomic():
            write = begin(verified=v, organisation_id=organisation_id, request_id=i)
            delete_category(
                write=write, category_id=category_id, if_match=r.headers.get("If-Match")
            )
        response = HttpResponse(status=204)
        del response["Content-Type"]
        return response

    return _serve(
        request,
        organisation_id,
        (PATCH_CATEGORY, DELETE_CATEGORY),
        {
            "PATCH": (UPDATE_SCOPE, lambda r, v, i: _patched(r, v, i, organisation_id, patch)),
            "DELETE": (DELETE_SCOPE, delete),
        },
    )


@declares(CREATE_CHANNEL)
def channels(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    def act(write: Write, body: dict[str, Any]) -> tuple[int, dict[str, Any], str]:
        row = create_channel(write=write, body=body)
        return 201, _channel(row), row.etag

    return _serve(
        request,
        organisation_id,
        (CREATE_CHANNEL,),
        {
            "POST": (
                CREATE_SCOPE,
                lambda r, v, i: _once(
                    r, v, i, organisation_id, act, takes_body=True, creating=True
                ),
            )
        },
    )


@declares(PATCH_CHANNEL)
def channel(request: HttpRequest, organisation_id: UUID, channel_id: UUID) -> HttpResponse:
    def patch(
        write: Write, body: dict[str, Any], if_match: str | None
    ) -> tuple[dict[str, Any], str]:
        row = patch_channel(write=write, channel_id=channel_id, body=body, if_match=if_match)
        return _channel(row), row.etag

    return _serve(
        request,
        organisation_id,
        (PATCH_CHANNEL,),
        {"PATCH": (UPDATE_SCOPE, lambda r, v, i: _patched(r, v, i, organisation_id, patch))},
    )


def _lifecycle(
    request: HttpRequest,
    organisation_id: UUID,
    channel_id: UUID,
    lifecycle: str,
    operation: Operation,
) -> HttpResponse:
    def act(write: Write, body: dict[str, Any]) -> tuple[int, dict[str, Any], str]:
        row = set_lifecycle(write=write, channel_id=channel_id, lifecycle=lifecycle)
        return 200, _channel(row), row.etag

    return _serve(
        request,
        organisation_id,
        (operation,),
        {
            "POST": (
                ACT_SCOPE,
                lambda r, v, i: _once(r, v, i, organisation_id, act, takes_body=False),
            )
        },
    )


@declares(ARCHIVE_CHANNEL)
def archive(request: HttpRequest, organisation_id: UUID, channel_id: UUID) -> HttpResponse:
    return _lifecycle(request, organisation_id, channel_id, ARCHIVED, ARCHIVE_CHANNEL)


@declares(UNARCHIVE_CHANNEL)
def unarchive(request: HttpRequest, organisation_id: UUID, channel_id: UUID) -> HttpResponse:
    return _lifecycle(request, organisation_id, channel_id, ACTIVE, UNARCHIVE_CHANNEL)


@declares(GET_CHANNEL_ACCESS, PATCH_CHANNEL_ACCESS)
def access(request: HttpRequest, organisation_id: UUID, channel_id: UUID) -> HttpResponse:
    def read(r: HttpRequest, v: VerifiedAccessToken, i: str) -> HttpResponse:
        found = read_access(verified=v, organisation_id=organisation_id, channel_id=channel_id)
        return _json(found.document(), found.etag)

    def patch(
        write: Write, body: dict[str, Any], if_match: str | None
    ) -> tuple[dict[str, Any], str]:
        changed = change_access(write=write, channel_id=channel_id, body=body, if_match=if_match)
        return changed.document(), changed.etag

    return _serve(
        request,
        organisation_id,
        (GET_CHANNEL_ACCESS, PATCH_CHANNEL_ACCESS),
        {
            "GET": (READ_SCOPE, read),
            "PATCH": (UPDATE_SCOPE, lambda r, v, i: _patched(r, v, i, organisation_id, patch)),
        },
    )


@declares(GET_WORKSPACE_ADMINISTRATION)
def administration(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    def read(r: HttpRequest, v: VerifiedAccessToken, i: str) -> HttpResponse:
        body = _administration(read_administration(verified=v, organisation_id=organisation_id))
        # One tag per rendered answer, evaluated after current authorisation, as getWorkspace's.
        etag = tag(body)
        candidates = parse_etags(r.headers.get("If-None-Match", ""))
        if "*" in candidates or any(c.removeprefix("W/") == etag for c in candidates):
            response = HttpResponse(status=304)
            del response["Content-Type"]
            response["ETag"] = etag
            return response
        return _json(body, etag)

    return _serve(
        request, organisation_id, (GET_WORKSPACE_ADMINISTRATION,), {"GET": (READ_SCOPE, read)}
    )
