"""Customer HTTP views for custom emojis, scheduled messages, reminders, and Kodera Labs."""

from __future__ import annotations

import hashlib
import json
from typing import Any
from uuid import UUID

from django.conf import settings
from django.core.exceptions import RequestDataTooBig
from django.http import HttpRequest, HttpResponse

from apps.workspaces import experience as service
from apps.workspaces.moderation import RefusalError
from core.api import lanes, problems
from core.api.scopes import declares
from services.identity.access_tokens import TokenVerificationError
from services.identity.trusted_issuers import verify_configured_token

from . import permissions, responses

EMOJI_CREATE_FIELDS = {"shortcode", "webp_base64", "webpBase64"}
SCHEDULED_CREATE_FIELDS = {
    "channel_id",
    "channelId",
    "room_id",
    "roomId",
    "body",
    "mentions",
    "thread_root_event_id",
    "threadRootEventId",
    "deliver_at",
    "deliverAt",
    "confidential",
    "encrypted",
}
SCHEDULED_PATCH_FIELDS = {"body", "mentions", "deliver_at", "deliverAt"}
REMINDER_CREATE_FIELDS = {
    "channel_id",
    "channelId",
    "room_id",
    "roomId",
    "target_event_id",
    "targetEventId",
    "note",
    "remind_at",
    "remindAt",
    "confidential",
    "encrypted",
}
REMINDER_PATCH_FIELDS = {"note", "remind_at", "remindAt", "state"}
PREFERENCES_PATCH_FIELDS = {
    "labs_flags",
    "labsFlags",
    "waiting_room_ambience",
    "waitingRoomAmbience",
}


def _etag_for(body: Any) -> str:
    digest = hashlib.sha256(
        json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return f'"{digest}"'


def _json_response(body: Any, status: int = 200, *, with_etag: bool = False) -> HttpResponse:
    response = HttpResponse(
        json.dumps(body, separators=(",", ":")),
        status=status,
        content_type="application/json",
    )
    if with_etag:
        response["ETag"] = _etag_for(body)
    return response


def _require_idempotency_key(request: HttpRequest) -> str:
    raw = request.headers.get("Idempotency-Key")
    if raw is None:
        raise RefusalError(400, "idempotency-key-missing")
    trimmed = raw.strip()
    if not (1 <= len(trimmed) <= 128) or any(ord(ch) < 33 or ord(ch) > 126 for ch in trimmed):
        raise RefusalError(400, "malformed-request")
    return trimmed


def _require_if_match(request: HttpRequest) -> str:
    raw = request.headers.get("If-Match")
    if raw is None:
        raise RefusalError(428, "precondition-required")
    trimmed = raw.strip()
    if not trimmed:
        raise RefusalError(400, "malformed-request")
    return trimmed


def _problem(status: int, request_id: str, kind: str | None = None) -> HttpResponse:
    default_kinds = {
        400: "malformed-request",
        401: "unauthenticated",
        403: "forbidden",
        404: "not-found",
        405: "method-not-allowed",
        409: "conflict",
        412: "precondition-failed",
        422: "validation-error",
        428: "precondition-required",
    }
    resolved_kind = kind or default_kinds.get(status, "malformed-request")
    payload: dict[str, Any] = {
        "type": f"https://kodera.io/problems/{resolved_kind}",
        "title": "Workspace request refused",
        "status": status,
        "code": resolved_kind,
        "request_id": request_id,
    }
    response = HttpResponse(
        json.dumps(payload, separators=(",", ":")),
        status=status,
        content_type="application/problem+json",
    )
    if status == 401:
        response["WWW-Authenticate"] = "Bearer"
    return response


def _parse_body(
    request: HttpRequest, allowed_fields: set[str], *, limit: int = 65536
) -> dict[str, Any]:
    def unique_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise RefusalError(400)
            result[key] = value
        return result

    if (
        request.content_type not in {"application/json", "application/merge-patch+json"}
        or len(request.body) > limit
    ):
        raise RefusalError(400)
    try:
        data = json.loads(request.body, object_pairs_hook=unique_pairs)
    except (ValueError, UnicodeError):
        raise RefusalError(400) from None
    if not isinstance(data, dict) or (data.keys() - allowed_fields):
        raise RefusalError(422)
    return data


def _serve(
    request: HttpRequest,
    handlers: dict[str, Any],
    *,
    operation_ids: dict[str, str] | None = None,
) -> HttpResponse:
    request_id = responses.request_id(request)
    method = request.method or ""
    if method not in handlers or method not in {"GET", "POST", "PATCH", "DELETE"}:
        response = _problem(405, request_id)
        response["Allow"] = ", ".join(handlers)
        return responses.finish(response, request_id)
    try:
        verified, lane = verify_configured_token(
            responses.bearer(request), trusted=settings.KODERA_AUTH_TRUST
        )
        verified, lane = lanes.admit(verified, lane)
        if lane == "staff":
            return responses.finish(_problem(403, request_id), request_id)
        response = handlers[method](verified, request_id)
        response["X-Request-Id"] = request_id
        if "Cache-Control" not in response:
            response["Cache-Control"] = "no-store"
        return response
    except TokenVerificationError:
        return responses.finish(_problem(401, request_id), request_id)
    except RequestDataTooBig:
        return responses.finish(_problem(400, request_id), request_id)
    except RefusalError as error:
        if error.kind == "identity-unknown":
            op_id = (operation_ids or {}).get(method, "workspaceExperience")
            return responses.finish(problems.identity_unknown(request_id, op_id), request_id)
        return responses.finish(_problem(error.status, request_id, error.kind), request_id)


@declares(
    permissions.LIST_WORKSPACE_CUSTOM_EMOJIS,
    permissions.CREATE_WORKSPACE_CUSTOM_EMOJI,
)
def emojis(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    def get(verified: Any, _: str) -> HttpResponse:
        return _json_response(
            service.list_emojis(verified=verified, organisation_id=organisation_id)
        )

    def post(verified: Any, request_id: str) -> HttpResponse:
        _require_idempotency_key(request)
        data = _parse_body(request, EMOJI_CREATE_FIELDS, limit=524288)
        body = service.create_emoji(
            verified=verified,
            organisation_id=organisation_id,
            data=data,
            request_id=request_id,
        )
        return _json_response(body, status=201)

    return _serve(
        request,
        {"GET": get, "POST": post},
        operation_ids={
            "GET": permissions.LIST_WORKSPACE_CUSTOM_EMOJIS.operation_id,
            "POST": permissions.CREATE_WORKSPACE_CUSTOM_EMOJI.operation_id,
        },
    )


@declares(permissions.DELETE_WORKSPACE_CUSTOM_EMOJI)
def emoji_detail(request: HttpRequest, organisation_id: UUID, emoji_id: UUID) -> HttpResponse:
    def delete(verified: Any, request_id: str) -> HttpResponse:
        service.delete_emoji(
            verified=verified,
            organisation_id=organisation_id,
            emoji_id=emoji_id,
            request_id=request_id,
        )
        return HttpResponse(status=204)

    return _serve(
        request,
        {"DELETE": delete},
        operation_ids={"DELETE": permissions.DELETE_WORKSPACE_CUSTOM_EMOJI.operation_id},
    )


@declares(permissions.GET_WORKSPACE_CUSTOM_EMOJI_BLOB)
def emoji_blob(request: HttpRequest, organisation_id: UUID, emoji_id: UUID) -> HttpResponse:
    def get(verified: Any, _: str) -> HttpResponse:
        webp_bytes, sha256 = service.get_emoji_blob(
            verified=verified,
            organisation_id=organisation_id,
            emoji_id=emoji_id,
        )
        response = HttpResponse(webp_bytes, status=200, content_type="image/webp")
        response["X-Content-Type-Options"] = "nosniff"
        response["Content-Security-Policy"] = "default-src 'none'"
        response["Cache-Control"] = "private, max-age=3600"
        response["ETag"] = f'"{sha256}"'
        return response

    return _serve(
        request,
        {"GET": get},
        operation_ids={"GET": permissions.GET_WORKSPACE_CUSTOM_EMOJI_BLOB.operation_id},
    )


@declares(
    permissions.LIST_SCHEDULED_MESSAGES,
    permissions.CREATE_SCHEDULED_MESSAGE,
)
def scheduled_messages(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    def get(verified: Any, _: str) -> HttpResponse:
        raw_ch = request.GET.get("channel_id") or request.GET.get("channelId")
        channel_id: UUID | None = None
        if raw_ch:
            try:
                channel_id = UUID(raw_ch)
            except ValueError:
                raise RefusalError(422) from None
        include_terminal = request.GET.get("include_terminal") == "true"
        return _json_response(
            service.list_scheduled_messages(
                verified=verified,
                organisation_id=organisation_id,
                channel_id=channel_id,
                include_terminal=include_terminal,
            )
        )

    def post(verified: Any, request_id: str) -> HttpResponse:
        _require_idempotency_key(request)
        data = _parse_body(request, SCHEDULED_CREATE_FIELDS, limit=32768)
        body = service.create_scheduled_message(
            verified=verified,
            organisation_id=organisation_id,
            data=data,
            request_id=request_id,
        )
        return _json_response(body, status=201, with_etag=True)

    return _serve(
        request,
        {"GET": get, "POST": post},
        operation_ids={
            "GET": permissions.LIST_SCHEDULED_MESSAGES.operation_id,
            "POST": permissions.CREATE_SCHEDULED_MESSAGE.operation_id,
        },
    )


@declares(
    permissions.UPDATE_SCHEDULED_MESSAGE,
    permissions.CANCEL_SCHEDULED_MESSAGE,
)
def scheduled_message_detail(
    request: HttpRequest, organisation_id: UUID, scheduled_message_id: UUID
) -> HttpResponse:
    def patch(verified: Any, request_id: str) -> HttpResponse:
        _require_if_match(request)
        data = _parse_body(request, SCHEDULED_PATCH_FIELDS, limit=32768)
        body = service.update_scheduled_message(
            verified=verified,
            organisation_id=organisation_id,
            scheduled_message_id=scheduled_message_id,
            data=data,
            request_id=request_id,
        )
        return _json_response(body, status=200, with_etag=True)

    def delete(verified: Any, request_id: str) -> HttpResponse:
        service.cancel_scheduled_message(
            verified=verified,
            organisation_id=organisation_id,
            scheduled_message_id=scheduled_message_id,
            request_id=request_id,
        )
        return HttpResponse(status=204)

    return _serve(
        request,
        {"PATCH": patch, "DELETE": delete},
        operation_ids={
            "PATCH": permissions.UPDATE_SCHEDULED_MESSAGE.operation_id,
            "DELETE": permissions.CANCEL_SCHEDULED_MESSAGE.operation_id,
        },
    )


@declares(
    permissions.LIST_PERSONAL_REMINDERS,
    permissions.CREATE_PERSONAL_REMINDER,
)
def reminders(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    def get(verified: Any, _: str) -> HttpResponse:
        include_completed = request.GET.get("include_completed") == "true"
        return _json_response(
            service.list_reminders(
                verified=verified,
                organisation_id=organisation_id,
                include_completed=include_completed,
            )
        )

    def post(verified: Any, request_id: str) -> HttpResponse:
        _require_idempotency_key(request)
        data = _parse_body(request, REMINDER_CREATE_FIELDS, limit=16384)
        body = service.create_reminder(
            verified=verified,
            organisation_id=organisation_id,
            data=data,
            request_id=request_id,
        )
        return _json_response(body, status=201, with_etag=True)

    return _serve(
        request,
        {"GET": get, "POST": post},
        operation_ids={
            "GET": permissions.LIST_PERSONAL_REMINDERS.operation_id,
            "POST": permissions.CREATE_PERSONAL_REMINDER.operation_id,
        },
    )


@declares(
    permissions.UPDATE_PERSONAL_REMINDER,
    permissions.DELETE_PERSONAL_REMINDER,
)
def reminder_detail(request: HttpRequest, organisation_id: UUID, reminder_id: UUID) -> HttpResponse:
    def patch(verified: Any, request_id: str) -> HttpResponse:
        _require_if_match(request)
        data = _parse_body(request, REMINDER_PATCH_FIELDS, limit=16384)
        body = service.update_reminder(
            verified=verified,
            organisation_id=organisation_id,
            reminder_id=reminder_id,
            data=data,
            request_id=request_id,
        )
        return _json_response(body, status=200, with_etag=True)

    def delete(verified: Any, request_id: str) -> HttpResponse:
        service.delete_reminder(
            verified=verified,
            organisation_id=organisation_id,
            reminder_id=reminder_id,
            request_id=request_id,
        )
        return HttpResponse(status=204)

    return _serve(
        request,
        {"PATCH": patch, "DELETE": delete},
        operation_ids={
            "PATCH": permissions.UPDATE_PERSONAL_REMINDER.operation_id,
            "DELETE": permissions.DELETE_PERSONAL_REMINDER.operation_id,
        },
    )


@declares(
    permissions.GET_MY_WORKSPACE_PREFERENCES,
    permissions.UPDATE_MY_WORKSPACE_PREFERENCES,
)
def my_preferences(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    def get(verified: Any, _: str) -> HttpResponse:
        return _json_response(
            service.get_my_preferences(verified=verified, organisation_id=organisation_id),
            with_etag=True,
        )

    def patch(verified: Any, request_id: str) -> HttpResponse:
        _require_if_match(request)
        data = _parse_body(request, PREFERENCES_PATCH_FIELDS, limit=8192)
        body = service.update_my_preferences(
            verified=verified,
            organisation_id=organisation_id,
            data=data,
            request_id=request_id,
        )
        return _json_response(body, status=200, with_etag=True)

    return _serve(
        request,
        {"GET": get, "PATCH": patch},
        operation_ids={
            "GET": permissions.GET_MY_WORKSPACE_PREFERENCES.operation_id,
            "PATCH": permissions.UPDATE_MY_WORKSPACE_PREFERENCES.operation_id,
        },
    )
