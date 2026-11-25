"""Current-authority confidential room discovery, verification bundles, and KVKB1 key backups."""

import json
from typing import Any
from uuid import UUID

from django.conf import settings
from django.http import HttpRequest, HttpResponse

from core.api import lanes, problems
from core.api.idempotency import StoredResponse, respond_once
from core.api.scopes import Operation, declares
from core.db.ids import new_uuid7
from services.identity.access_tokens import TokenVerificationError
from services.identity.trusted_issuers import verify_configured_token

from .. import services

MAX_KEY_BACKUP_REQUEST_BYTES = 400_000


def _parse_json_object(raw: bytes, *, max_bytes: int) -> dict[str, Any]:
    if len(raw) > max_bytes:
        raise services.RefusalError(400)
    try:

        def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
            result: dict[str, Any] = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError("duplicate field")
                result[key] = value
            return result

        def finite(_: str) -> None:
            raise ValueError("non-finite number")

        body = json.loads(raw, object_pairs_hook=unique, parse_constant=finite)
    except (ValueError, UnicodeError, RecursionError):
        raise services.RefusalError(400) from None
    if not isinstance(body, dict):
        raise services.RefusalError(422)
    return body


def _serve(
    request: HttpRequest, organisation_id: UUID, room_id: UUID | None = None
) -> HttpResponse:
    request_id = str(new_uuid7())
    operation_id = (
        "discoverConfidentialRoom" if room_id is not None else "publishDeviceVerificationBundle"
    )
    reading = room_id is not None
    method = "GET" if reading else "POST"
    try:
        if request.method != method:
            raise services.RefusalError(405)
        header = request.headers.get("Authorization", "")
        verified, lane = verify_configured_token(
            header[7:] if header.startswith("Bearer ") else "", trusted=settings.KODERA_AUTH_TRUST
        )
        verified, lane = lanes.admit(verified, lane)
        if lane == "staff":
            raise services.RefusalError(403)
        services.enabled()
        services.admit_directory(verified=verified, organisation_id=organisation_id)
        if room_id is not None:
            result = services.discover(
                verified=verified,
                organisation_id=organisation_id,
                room_id=room_id,
                device_id=request.GET.get("deviceId", ""),
            )
            if set(request.GET) != {"deviceId"} or len(request.GET.getlist("deviceId")) != 1:
                raise services.RefusalError(422)
            response = HttpResponse(json.dumps(result), content_type="application/json")
        else:
            if request.content_type != "application/json":
                raise services.RefusalError(400)
            body = _parse_json_object(request.body, max_bytes=8192)
            if set(body) != {
                "deviceId",
                "revision",
                "masterKey",
                "selfSigningKey",
                "crossSigningSignature",
                "deviceSignature",
                "signature",
            }:
                raise services.RefusalError(422)

            def authority(_: Any) -> None:
                services.verification_context(
                    verified=verified, organisation_id=organisation_id, body=body
                )

            authority(None)

            def execute() -> StoredResponse:
                result = services.publish_bundle(
                    verified=verified,
                    organisation_id=organisation_id,
                    body=body,
                    request_id=request_id,
                )
                return StoredResponse(
                    status=201, body=json.dumps(result).encode(), content_type="application/json"
                )

            response = respond_once(
                request,
                issuer=verified.issuer,
                subject=verified.subject,
                request_id=request_id,
                handler=execute,
                authority=authority,
            )
    except TokenVerificationError:
        failure = services.RefusalError(401)
        response = _problem(failure, request_id, operation_id)
    except services.RefusalError as failure:
        response = _problem(failure, request_id, operation_id)
    response["X-Request-Id"] = request_id
    response["Cache-Control"] = "no-store"
    if response.status_code == 405:
        response["Allow"] = method
    return response


def _serve_key_backup(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    request_id = str(new_uuid7())
    operations = {
        "GET": "getConfidentialKeyBackup",
        "POST": "publishConfidentialKeyBackup",
        "DELETE": "discardConfidentialKeyBackup",
    }
    operation_id = operations.get(request.method or "", "getConfidentialKeyBackup")
    try:
        if request.method not in operations:
            raise services.RefusalError(405)
        header = request.headers.get("Authorization", "")
        verified, lane = verify_configured_token(
            header[7:] if header.startswith("Bearer ") else "", trusted=settings.KODERA_AUTH_TRUST
        )
        verified, lane = lanes.admit(verified, lane)
        if lane == "staff":
            raise services.RefusalError(403)
        services.enabled()
        services.admit_directory(verified=verified, organisation_id=organisation_id)
        if request.GET:
            raise services.RefusalError(422)
        if request.method == "GET":
            result = services.get_key_backup(
                verified=verified,
                organisation_id=organisation_id,
            )
            response = HttpResponse(json.dumps(result), content_type="application/json")
        elif request.method == "DELETE":
            if request.body:
                raise services.RefusalError(400)
            next_epoch = services.discard_key_backup(
                verified=verified,
                organisation_id=organisation_id,
                request_id=request_id,
            )
            response = HttpResponse(status=204)
            response["X-Kodera-Next-Backup-Epoch"] = str(next_epoch)
        else:
            if request.content_type != "application/json":
                raise services.RefusalError(400)
            body = _parse_json_object(request.body, max_bytes=MAX_KEY_BACKUP_REQUEST_BYTES)
            if set(body) != {"deviceId", "backupEpoch", "capsule", "signature"}:
                raise services.RefusalError(422)

            def authority(_: Any) -> None:
                services.key_backup_publish_context(
                    verified=verified, organisation_id=organisation_id, body=body
                )

            authority(None)

            def execute() -> StoredResponse:
                result = services.publish_key_backup(
                    verified=verified,
                    organisation_id=organisation_id,
                    body=body,
                    request_id=request_id,
                )
                return StoredResponse(
                    status=201, body=json.dumps(result).encode(), content_type="application/json"
                )

            response = respond_once(
                request,
                issuer=verified.issuer,
                subject=verified.subject,
                request_id=request_id,
                handler=execute,
                authority=authority,
            )
    except TokenVerificationError:
        failure = services.RefusalError(401)
        response = _problem(failure, request_id, operation_id)
    except services.RefusalError as failure:
        response = _problem(failure, request_id, operation_id)
    response["X-Request-Id"] = request_id
    response["Cache-Control"] = "no-store"
    if response.status_code == 405:
        response["Allow"] = "DELETE, GET, POST"
    return response


def _problem(failure: services.RefusalError, request_id: str, operation_id: str) -> HttpResponse:
    if failure.kind == "identity-unknown":
        return problems.identity_unknown(request_id, operation_id)
    kinds = {
        400: "malformed-request",
        401: "unauthenticated",
        403: "forbidden",
        404: "not-found",
        405: "method-not-allowed",
        409: "conflict",
        422: "validation-error",
        503: "service-unavailable",
    }
    title = (
        "Confidential discovery request refused"
        if operation_id in {"discoverConfidentialRoom", "publishDeviceVerificationBundle"}
        else "Confidential key backup request refused"
    )
    response = HttpResponse(
        json.dumps(
            {
                "type": "https://kodera.io/problems/" + (failure.kind or kinds[failure.status]),
                "title": title,
                "status": failure.status,
                "request_id": request_id,
            }
        ),
        status=failure.status,
        content_type="application/problem+json",
    )
    if failure.next_backup_epoch is not None:
        response["X-Kodera-Next-Backup-Epoch"] = str(failure.next_backup_epoch)
    if failure.status == 401:
        response["WWW-Authenticate"] = "Bearer"
    if failure.status == 503:
        response["Retry-After"] = "1"
    return response


@declares(Operation("GET", "discoverConfidentialRoom", "confidential_room:read"))
def discovery(request: HttpRequest, organisation_id: UUID, room_id: UUID) -> HttpResponse:
    return _serve(request, organisation_id, room_id)


@declares(Operation("POST", "publishDeviceVerificationBundle", "confidential_device:create"))
def bundles(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    return _serve(request, organisation_id)


@declares(
    Operation("GET", "getConfidentialKeyBackup", "confidential_backup:read"),
    Operation("POST", "publishConfidentialKeyBackup", "confidential_backup:create"),
    Operation("DELETE", "discardConfidentialKeyBackup", "confidential_backup:delete"),
)
def key_backup(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    return _serve_key_backup(request, organisation_id)
