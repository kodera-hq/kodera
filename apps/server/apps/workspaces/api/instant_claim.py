"""Claim an already prepared database allocation, with current owner authority on every replay."""

import json
import logging
import re
from urllib.parse import urlsplit
from uuid import UUID

from django.conf import settings
from django.db import transaction
from django.http import HttpRequest, HttpResponse
from django.utils import timezone

from apps.identity.selectors import current_identity
from apps.orgs.actor_selectors import (
    TenantCaller,
    TenantCallerNotFoundError,
    TenantCallerUnknownError,
    read_tenant_caller,
)
from apps.workspaces.initialise import lock_organisation
from apps.workspaces.models import Channel, WarmPoolAllocation
from apps.workspaces.warm_pool import (
    InstantClaimInputError,
    build_instant_claim_plan,
    build_instant_claim_response,
    parse_instant_claim_request,
)
from core.api import lanes
from core.api.idempotency import StoredResponse, respond_once
from core.api.scopes import Operation, declares
from services.identity.access_tokens import TokenVerificationError, VerifiedAccessToken
from services.identity.trusted_issuers import verify_configured_token

from . import responses

OPERATION = Operation(method="POST", operation_id="instantClaimWorkspace", scope="workspace:act")
LOG = logging.getLogger(__name__)


class ClaimForbiddenError(Exception):
    """The current customer is not an active organisation owner."""


class PoolUnavailableError(Exception):
    """No matching, ready, worker-prepared allocation exists. Never persisted for replay."""


def _owner(verified: VerifiedAccessToken) -> TenantCaller:
    resolved = current_identity(issuer=verified.issuer, subject=verified.subject)
    if resolved is None:
        raise ClaimForbiddenError()
    _, identity = resolved
    caller = read_tenant_caller(verified=verified, organisation_id=identity.organisation_id)
    if caller.role != "org_owner" or caller.organisation_state != "active":
        raise ClaimForbiddenError()
    return caller


def _public_https(value: str) -> bool:
    try:
        url = urlsplit(value)
        return (
            len(value) <= 4096
            and url.scheme == "https"
            and bool(url.hostname)
            and re.fullmatch(r"(?:[a-z0-9-]+\.)+[a-z]{2,63}", url.hostname or "") is not None
            and not url.username
            and not url.password
            and not url.port
            and not (url.hostname or "").endswith(
                (".local", ".internal", ".localhost", ".test", ".invalid")
            )
            and not any(ord(ch) < 33 or ch == "\\" for ch in value)
        )
    except ValueError:
        return False


def _claim(request: HttpRequest, organisation_id: UUID, request_id: str) -> StoredResponse:
    try:
        payload = parse_instant_claim_request(request.body, request.content_type or "")
    except InstantClaimInputError:
        status, body = responses.document("malformed-request", request_id, {})
        return StoredResponse(status=status, body=body, content_type=responses.PROBLEM_TYPE)
    plan = build_instant_claim_plan(payload)
    allocation = (
        WarmPoolAllocation.objects.select_for_update()
        .filter(workspace__organisation_id=organisation_id, slug=payload.slug)
        .first()
    )
    if allocation is None or not plan["warm_pool_eligible"]:
        raise PoolUnavailableError()
    if allocation.claimed_at is not None:
        status, body = responses.document("conflict", request_id, {})
        return StoredResponse(status=status, body=body, content_type=responses.PROBLEM_TYPE)
    if allocation.plan != plan or not all(
        map(
            _public_https,
            (
                allocation.workspace_url,
                allocation.invitation_url,
            ),
        )
    ):
        raise PoolUnavailableError()
    channels = list(Channel.objects.filter(workspace_id=allocation.workspace_id).order_by("id"))
    expected = {(ch["db_template_key"], ch["name"], ch["kind"]) for ch in plan["channels"]}
    actual = {
        (ch.template_key, ch.name, ch.kind)
        for ch in channels
        if ch.lifecycle == "active" and ch.room_state == "ready"
    }
    if len(channels) != len(expected) or actual != expected:
        raise PoolUnavailableError()
    result = build_instant_claim_response(
        payload,
        workspace_id=str(allocation.workspace_id),
        workspace_url=allocation.workspace_url,
        invitation_url=allocation.invitation_url,
        offer_mode=allocation.offer_mode,
    )
    result["channels"] = [{"id": str(ch.id), "name": ch.name, "kind": ch.kind} for ch in channels]
    allocation.claimed_at = timezone.now()
    allocation.save(update_fields=["claimed_at"])
    return StoredResponse(
        status=201, body=json.dumps(result).encode(), content_type="application/json"
    )


@declares(OPERATION)
def instant_claim(request: HttpRequest) -> HttpResponse:
    request_id = responses.request_id(request)
    try:
        if request.method != "POST":
            response = responses.problem("method-not-allowed", request_id, allowed=["POST"])
            response["Allow"] = "POST"
            return responses.finish(response, request_id)
        verified, lane = verify_configured_token(
            responses.bearer(request), trusted=settings.KODERA_AUTH_TRUST
        )
        verified, lane = lanes.admit(verified, lane)
        if lane != "customer":
            raise ClaimForbiddenError()
        with transaction.atomic():
            caller = _owner(verified)

        def authority(_event):
            # The same organisation lock serializes membership/owner changes and allocation.
            lock_organisation(caller.organisation_id)
            current = _owner(verified)
            if current.organisation_id != caller.organisation_id:
                raise ClaimForbiddenError()

        response = respond_once(
            request,
            issuer=verified.issuer,
            subject=verified.subject,
            request_id=request_id,
            authority=authority,
            handler=lambda: _claim(request, caller.organisation_id, request_id),
        )
    except TokenVerificationError:
        response = responses.problem("unauthenticated", request_id)
    except (ClaimForbiddenError, TenantCallerUnknownError, TenantCallerNotFoundError):
        response = responses.problem("forbidden", request_id)
    except PoolUnavailableError:
        response = responses.problem(
            "service-unavailable", request_id, code="warm_pool_unavailable"
        )
    except Exception as failure:
        LOG.error(
            "instantClaimWorkspace failed: %s request_id=%s", type(failure).__name__, request_id
        )
        response = responses.problem("internal-error", request_id)
    return responses.finish(response, request_id)
