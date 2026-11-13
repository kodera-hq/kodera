"""Contract 0.43.0 moderation, report queues and reusable invite links."""

import json
from datetime import datetime
from typing import Any
from uuid import UUID

from django.conf import settings
from django.core.exceptions import RequestDataTooBig
from django.http import HttpRequest, HttpResponse

from apps.workspaces import moderation as service
from apps.workspaces.moderation_wire import link_wire, page, report_wire, tag
from core.api import lanes
from core.api.idempotency import StoredResponse, respond_once
from core.api.scopes import Operation, declares
from services.identity.access_tokens import TokenVerificationError
from services.identity.trusted_issuers import verify_configured_token

from . import responses


def _json(body: Any, status: int = 200, *, etag: bool = False) -> HttpResponse:
    response = HttpResponse(
        json.dumps(body, separators=(",", ":")), status=status, content_type="application/json"
    )
    if etag:
        response["ETag"] = tag(body)
    return response


def _problem(status: int, request_id: str, kind: str | None = None) -> HttpResponse:
    kinds = {
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
    response = HttpResponse(
        json.dumps(
            {
                "type": "https://kodera.io/problems/" + (kind or kinds[status]),
                "title": "Workspace request refused",
                "status": status,
                "request_id": request_id,
            }
        ),
        status=status,
        content_type="application/problem+json",
    )
    if status == 401:
        response["WWW-Authenticate"] = "Bearer"
    return response


def _body(request: HttpRequest, fields: set[str], required: set[str]) -> dict[str, Any]:
    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result = {}
        for key, value in pairs:
            if key in result:
                raise service.RefusalError(400)
            result[key] = value
        return result

    if (
        request.content_type not in {"application/json", "application/merge-patch+json"}
        or len(request.body) > 32768
    ):
        raise service.RefusalError(400)
    try:
        data = json.loads(request.body, object_pairs_hook=unique)
    except (ValueError, UnicodeError):
        raise service.RefusalError(400) from None
    if not isinstance(data, dict) or not required <= data.keys() or data.keys() - fields:
        raise service.RefusalError(422)
    return data


def _uuid(value: Any) -> UUID:
    if not isinstance(value, str):
        raise service.RefusalError(422)
    try:
        return UUID(value)
    except ValueError:
        raise service.RefusalError(422) from None


def _time(value: Any) -> datetime:
    if not isinstance(value, str):
        raise service.RefusalError(422)
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise service.RefusalError(422) from None


def _serve(request: HttpRequest, handlers: dict[str, Any]) -> HttpResponse:
    request_id = responses.request_id(request)
    method = request.method or ""
    try:
        if method not in handlers or method not in {
            "GET",
            "POST",
            "PATCH",
            "DELETE",
        }:
            response = _problem(405, request_id)
            response["Allow"] = ", ".join(method for method in handlers if method != "AUTHORIZE")
        else:
            verified, lane = verify_configured_token(
                responses.bearer(request), trusted=settings.KODERA_AUTH_TRUST
            )
            verified, lane = lanes.admit(verified, lane)
            if lane == "staff":
                raise service.RefusalError(403)

            def execute() -> HttpResponse:
                try:
                    return handlers[method](verified, request_id)
                except service.RefusalError as error:
                    return _problem(error.status, request_id, error.kind)

            if method == "POST":
                # Authorization is checked again inside the effect transaction. Also check
                # current access before replay so revocation cannot replay a disclosed response.
                handlers["AUTHORIZE"](verified)

                def effect() -> StoredResponse:
                    response = execute()
                    return StoredResponse(
                        status=response.status_code,
                        body=response.content,
                        content_type=response.get("Content-Type", "application/json"),
                        etag=response.get("ETag"),
                    )

                response = respond_once(
                    request,
                    issuer=verified.issuer,
                    subject=verified.subject,
                    request_id=request_id,
                    handler=effect,
                    authority=lambda _: handlers["AUTHORIZE"](verified),
                )
            else:
                response = execute()
    except TokenVerificationError:
        response = _problem(401, request_id)
    except RequestDataTooBig:
        response = _problem(400, request_id)
    except service.RefusalError as error:
        response = _problem(error.status, request_id, error.kind)
    return responses.finish(response, request_id)


def _authorize(
    verified: Any, organisation_id: UUID, *, moderator: bool = False, admin: bool = False
) -> None:
    service.authorise_workspace(
        verified=verified, organisation_id=organisation_id, moderator=moderator, admin=admin
    )


@declares(Operation("POST", "moderateWorkspaceMember", "workspace_moderation:act"))
def moderation(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    def post(verified: Any, request_id: str) -> HttpResponse:
        data = _body(
            request,
            {"membershipId", "action", "reason", "expiresAt"},
            {"membershipId", "action", "reason"},
        )
        result = service.moderate(
            verified=verified,
            organisation_id=organisation_id,
            target_id=_uuid(data["membershipId"]),
            action=data["action"],
            reason=data["reason"],
            expires_at=_time(data["expiresAt"]) if "expiresAt" in data else None,
            request_id=request_id,
        )
        return _json(result)

    return _serve(
        request,
        {
            "POST": post,
            "AUTHORIZE": lambda verified: _authorize(verified, organisation_id, moderator=True),
        },
    )


@declares(
    Operation("GET", "listAbuseReports", "workspace_report:read"),
    Operation("POST", "createAbuseReport", "workspace_report:create"),
)
def reports(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    def post(verified: Any, request_id: str) -> HttpResponse:
        data = _body(
            request, {"membershipId", "channelId", "eventId", "reason"}, {"membershipId", "reason"}
        )
        if "eventId" in data and (not isinstance(data["eventId"], str) or not data["eventId"]):
            raise service.RefusalError(422)
        row = service.report(
            verified=verified,
            organisation_id=organisation_id,
            target_id=_uuid(data["membershipId"]),
            reason=data["reason"],
            channel_id=_uuid(data["channelId"]) if "channelId" in data else None,
            event_id=data.get("eventId", ""),
            request_id=request_id,
        )
        return _json(report_wire(row), 201, etag=True)

    return _serve(
        request,
        {
            "POST": post,
            "GET": lambda verified, _: _page(request, verified, organisation_id, "reports"),
            "AUTHORIZE": lambda verified: _authorize(verified, organisation_id),
        },
    )


def _page(request: HttpRequest, verified: Any, organisation_id: UUID, kind: str) -> HttpResponse:
    allowed = {"cursor", "limit", "status"} if kind == "links" else {"cursor", "limit"}
    if set(request.GET) - allowed or any(len(values) != 1 for _, values in request.GET.lists()):
        raise service.RefusalError(400)
    try:
        limit = int(request.GET.get("limit", "50"))
    except ValueError:
        raise service.RefusalError(400) from None
    return _json(
        page(
            verified=verified,
            organisation_id=organisation_id,
            kind=kind,
            cursor=request.GET.get("cursor"),
            limit=limit,
            status=request.GET.get("status", "all"),
        )
    )


@declares(Operation("PATCH", "resolveAbuseReport", "workspace_report:update"))
def report_detail(request: HttpRequest, organisation_id: UUID, report_id: UUID) -> HttpResponse:
    def patch(verified: Any, request_id: str) -> HttpResponse:
        data = _body(request, {"status", "resolution"}, {"status", "resolution"})
        row = service.resolve_report(
            verified=verified,
            organisation_id=organisation_id,
            report_id=report_id,
            status=data["status"],
            resolution=data["resolution"],
            if_match=request.headers.get("If-Match", ""),
            request_id=request_id,
        )
        return _json(report_wire(row), etag=True)

    return _serve(request, {"PATCH": patch})


@declares(
    Operation("GET", "listWorkspaceInviteLinks", "workspace_invite_link:read"),
    Operation("POST", "createWorkspaceInviteLink", "workspace_invite_link:create"),
)
def links(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    def post(verified: Any, request_id: str) -> HttpResponse:
        data = _body(
            request, {"expiresAt", "maxUses", "channelId", "role"}, {"expiresAt", "maxUses"}
        )
        row, code = service.create_link(
            verified=verified,
            organisation_id=organisation_id,
            expires_at=_time(data["expiresAt"]),
            max_uses=data["maxUses"],
            role=data.get("role", "org_member"),
            channel_id=_uuid(data["channelId"]) if "channelId" in data else None,
            request_id=request_id,
        )
        return _json({"link": link_wire(row), "code": code}, 201)

    return _serve(
        request,
        {
            "POST": post,
            "GET": lambda verified, _: _page(request, verified, organisation_id, "links"),
            "AUTHORIZE": lambda verified: _authorize(verified, organisation_id, admin=True),
        },
    )


@declares(Operation("DELETE", "revokeWorkspaceInviteLink", "workspace_invite_link:delete"))
def link_detail(request: HttpRequest, organisation_id: UUID, invite_link_id: UUID) -> HttpResponse:
    def delete(verified: Any, request_id: str) -> HttpResponse:
        service.revoke_link(
            verified=verified,
            organisation_id=organisation_id,
            link_id=invite_link_id,
            request_id=request_id,
        )
        return HttpResponse(status=204)

    return _serve(request, {"DELETE": delete})


def _invite(request: HttpRequest, *, redeem: bool) -> HttpResponse:
    def authorize(verified: Any) -> None:
        data = _body(request, {"code"}, {"code"})
        (service.admit_redemption if redeem else service.preview_link)(
            verified=verified, code=data["code"]
        )

    def post(verified: Any, request_id: str) -> HttpResponse:
        data = _body(request, {"code"}, {"code"})
        if redeem:
            member = service.redeem_link(
                verified=verified, code=data["code"], request_id=request_id
            )
            return _json(
                {"organisationId": str(member.organisation_id), "membershipId": str(member.id)}
            )
        row = service.preview_link(verified=verified, code=data["code"])
        return _json(
            {
                "organisationName": row.workspace.organisation.name,
                "role": row.role,
                "expiresAt": row.expires_at.isoformat(),
            }
        )

    return _serve(request, {"POST": post, "AUTHORIZE": authorize})


@declares(Operation("POST", "previewWorkspaceInvite", "workspace_invite_link:read"))
def preview(request: HttpRequest) -> HttpResponse:
    return _invite(request, redeem=False)


@declares(Operation("POST", "redeemWorkspaceInvite", "workspace_invite_link:act"))
def redeem(request: HttpRequest) -> HttpResponse:
    return _invite(request, redeem=True)
