"""Ephemeral `#proximity` HTTP endpoints (`bootstrap`, `checkin`, `resolve`, `nearby`, `checkout`)."""

from __future__ import annotations

from typing import Any

from django.conf import settings
from django.http import HttpRequest, HttpResponse

from services.identity.access_tokens import VerifiedAccessToken

from ..services import (
    DEFAULT_BROKER,
    ProximityBroker,
    ProximityRefusalError,
    assert_zero_gps_query,
    authorise_proximity_workspace,
)
from . import http


def _active_broker() -> ProximityBroker:
    configured: Any = getattr(settings, "KODERA_PROXIMITY_BROKER", None)
    return configured if isinstance(configured, ProximityBroker) else DEFAULT_BROKER


def bootstrap(request: HttpRequest) -> HttpResponse:
    def post(verified: VerifiedAccessToken) -> HttpResponse:
        payload = http.parse_json_body(
            request,
            allowed_fields={"workspace_id", "event_scope"},
            required_fields={"workspace_id"},
        )
        workspace_id = http.parse_uuid(payload["workspace_id"])
        authorise_proximity_workspace(verified=verified, workspace_id=workspace_id)
        result = _active_broker().bootstrap(
            workspace_id=workspace_id,
            event_scope=payload.get("event_scope", "default"),
        )
        return http.json_response(result, status=200)

    return http.serve(request, {"POST": post})


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
        if not isinstance(transport, str) or not isinstance(distance_band, str):
            raise ProximityRefusalError(422, reason="invalid_transport_or_band")

        authorise_proximity_workspace(verified=verified, workspace_id=workspace_id)
        result = _active_broker().checkin(
            principal_key=http.principal_key_for(verified),
            workspace_id=workspace_id,
            beacon_token_hex=beacon_token,
            event_scope=payload.get("event_scope", "default"),
            ttl_seconds=payload.get("ttl_seconds"),
            status_note=payload.get("status_note"),
            handle=payload.get("handle"),
            transport=transport,
            distance_band=distance_band,
        )
        return http.json_response(result, status=201)

    return http.serve(request, {"POST": post})


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

        authorise_proximity_workspace(verified=verified, workspace_id=workspace_id)
        result = _active_broker().resolve(
            principal_key=http.principal_key_for(verified),
            workspace_id=workspace_id,
            observed_tokens=observed_tokens,
            event_scope=payload.get("event_scope", "default"),
        )
        return http.json_response(result, status=200)

    return http.serve(request, {"POST": post})


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
        authorise_proximity_workspace(verified=verified, workspace_id=workspace_id)
        result = _active_broker().nearby(
            principal_key=http.principal_key_for(verified),
            workspace_id=workspace_id,
            event_scope=event_scope,
        )
        return http.json_response(result, status=200)

    return http.serve(request, {"GET": get})


def checkout(request: HttpRequest) -> HttpResponse:
    def post(verified: VerifiedAccessToken) -> HttpResponse:
        payload = http.parse_json_body(
            request,
            allowed_fields={"workspace_id", "event_scope"},
            required_fields={"workspace_id"},
        )
        workspace_id = http.parse_uuid(payload["workspace_id"])
        raw_scope = payload.get("event_scope")
        authorise_proximity_workspace(verified=verified, workspace_id=workspace_id)
        result = _active_broker().checkout(
            principal_key=http.principal_key_for(verified),
            workspace_id=workspace_id,
            event_scope=raw_scope,
        )
        return http.json_response(result, status=200)

    return http.serve(request, {"POST": post})
