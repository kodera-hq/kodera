"""Ephemeral `#proximity` HTTP endpoints (`bootstrap`, `checkin`, `resolve`, `nearby`, `checkout`)."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from django.conf import settings
from django.db import OperationalError, transaction
from django.http import HttpRequest, HttpResponse

from core.api.scopes import declares
from services.identity.access_tokens import VerifiedAccessToken

from ..authority import admit_operation
from ..broker_rpc import BrokerGateway
from ..services import (
    ProximityBroker,
    ProximityRefusalError,
    assert_zero_gps_query,
)
from . import http, permissions


def _active_broker() -> ProximityBroker | BrokerGateway:
    configured: Any = getattr(settings, "KODERA_PROXIMITY_BROKER", None)
    if isinstance(configured, ProximityBroker):
        return configured
    return BrokerGateway(getattr(settings, "KODERA_PROXIMITY_BROKER_SOCKET", None))


def _operation(
    verified: VerifiedAccessToken,
    workspace_id: UUID,
    operation: str,
    *,
    status: int = 200,
    **arguments: Any,
) -> HttpResponse:
    try:
        with transaction.atomic():
            broker = _active_broker()
            caller = admit_operation(
                verified=verified,
                workspace_id=workspace_id,
                broker=broker,
                disclose_peers=operation in {"resolve", "nearby"},
            )
            handlers = {
                "bootstrap": broker.bootstrap,
                "checkin": broker.checkin,
                "resolve": broker.resolve,
                "nearby": broker.nearby,
                "checkout": broker.checkout,
            }
            if operation != "bootstrap":
                # The broker never retains raw issuer/subject identity claims.
                arguments["principal_key"] = str(caller.identity_id)
            result = handlers[operation](workspace_id=workspace_id, **arguments)
            # Finish serializing personal data before the operation's authority fences release.
            return http.json_response(result, status=status)
    except OperationalError as failure:
        if getattr(failure.__cause__, "sqlstate", None) in {
            "55P03",
            "57014",
            "53200",
            "53300",
            "53400",
            "40P01",
        }:
            raise ProximityRefusalError(503, reason="proximity_authority_unavailable") from None
        raise


@declares(permissions.BOOTSTRAP)
def bootstrap(request: HttpRequest) -> HttpResponse:
    def post(verified: VerifiedAccessToken) -> HttpResponse:
        payload = http.parse_json_body(
            request,
            allowed_fields={"workspace_id", "event_scope"},
            required_fields={"workspace_id"},
        )
        workspace_id = http.parse_uuid(payload["workspace_id"])
        return _operation(
            verified,
            workspace_id,
            "bootstrap",
            event_scope=payload.get("event_scope", "default"),
        )

    return http.serve(request, {"POST": post})


@declares(permissions.CHECK_IN)
def checkin(request: HttpRequest) -> HttpResponse:
    def post(verified: VerifiedAccessToken) -> HttpResponse:
        payload = http.parse_json_body(
            request,
            allowed_fields={
                "workspace_id",
                "beacon_token",
                "event_scope",
                "ttl_seconds",
                "status_note",
                "handle",
                "transport",
                "distance_band",
            },
            required_fields={"workspace_id", "beacon_token"},
        )
        workspace_id = http.parse_uuid(payload["workspace_id"])
        beacon_token = payload["beacon_token"]
        if not isinstance(beacon_token, str):
            raise ProximityRefusalError(422, reason="invalid_beacon_token")
        transport = payload.get("transport", "hybrid")
        distance_band = payload.get("distance_band", "near")
        event_scope = payload.get("event_scope", "default")
        if (
            not isinstance(transport, str)
            or not isinstance(distance_band, str)
            or not isinstance(event_scope, str)
        ):
            raise ProximityRefusalError(422, reason="invalid_transport_or_band")

        return _operation(
            verified,
            workspace_id,
            "checkin",
            status=201,
            beacon_token_hex=beacon_token,
            event_scope=event_scope,
            ttl_seconds=payload.get("ttl_seconds"),
            status_note=payload.get("status_note"),
            handle=payload.get("handle"),
            transport=transport,
            distance_band=distance_band,
        )

    return http.serve(request, {"POST": post})


@declares(permissions.RESOLVE)
def resolve(request: HttpRequest) -> HttpResponse:
    def post(verified: VerifiedAccessToken) -> HttpResponse:
        payload = http.parse_json_body(
            request,
            allowed_fields={"workspace_id", "event_scope", "observed_tokens"},
            required_fields={"workspace_id", "observed_tokens"},
        )
        workspace_id = http.parse_uuid(payload["workspace_id"])
        observed_tokens = payload["observed_tokens"]
        if not isinstance(observed_tokens, list):
            raise ProximityRefusalError(422, reason="invalid_observed_tokens")

        return _operation(
            verified,
            workspace_id,
            "resolve",
            observed_tokens=observed_tokens,
            event_scope=payload.get("event_scope", "default"),
        )

    return http.serve(request, {"POST": post})


@declares(permissions.NEARBY)
def nearby(request: HttpRequest) -> HttpResponse:
    def get(verified: VerifiedAccessToken) -> HttpResponse:
        assert_zero_gps_query(request.GET)
        allowed_query = {"workspace_id", "event_scope"}
        if set(request.GET.keys()) - allowed_query or "workspace_id" not in request.GET:
            raise ProximityRefusalError(422, reason="invalid_query_parameters")
        if any(len(request.GET.getlist(key)) != 1 for key in request.GET):
            raise ProximityRefusalError(400, reason="duplicate_query_parameter")

        workspace_id = http.parse_uuid(request.GET.get("workspace_id"))
        event_scope = request.GET.get("event_scope", "default")
        return _operation(
            verified,
            workspace_id,
            "nearby",
            event_scope=event_scope,
        )

    return http.serve(request, {"GET": get})


@declares(permissions.CHECK_OUT)
def checkout(request: HttpRequest) -> HttpResponse:
    def post(verified: VerifiedAccessToken) -> HttpResponse:
        payload = http.parse_json_body(
            request,
            allowed_fields={"workspace_id", "event_scope"},
            required_fields={"workspace_id"},
        )
        workspace_id = http.parse_uuid(payload["workspace_id"])
        raw_scope = payload.get("event_scope")
        return _operation(
            verified,
            workspace_id,
            "checkout",
            event_scope=raw_scope,
        )

    return http.serve(request, {"POST": post})
