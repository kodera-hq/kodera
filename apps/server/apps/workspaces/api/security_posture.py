"""Workspace cybersecurity posture advisor read and 1-click safe remediation endpoints."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from django.http import HttpRequest, HttpResponse

from apps.workspaces import security_posture as service
from core.api.scopes import declares

from .moderation import _body, _json, _serve
from .permissions import (
    GET_WORKSPACE_SECURITY_POSTURE,
    REMEDIATE_WORKSPACE_SECURITY_POSTURE,
)


@declares(GET_WORKSPACE_SECURITY_POSTURE)
def posture(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    return _serve(
        request,
        {
            "GET": lambda verified, _: _json(
                service.read_security_posture(verified=verified, organisation_id=organisation_id)
            )
        },
    )


@declares(REMEDIATE_WORKSPACE_SECURITY_POSTURE)
def remediate(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    def post(verified: Any, request_id: str) -> HttpResponse:
        data = _body(request, {"action"}, {"action"})
        result = service.remediate_security_posture(
            verified=verified,
            organisation_id=organisation_id,
            action=data["action"],
            request_id=request_id,
        )
        return _json(result)

    return _serve(
        request,
        {
            "POST": post,
            "AUTHORIZE": lambda verified: service.authorize_posture_admin(
                verified, organisation_id
            ),
        },
    )
