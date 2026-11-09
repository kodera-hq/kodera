"""`POST /api/v1/organisations`, the staff intake: docs/specs/ORGANISATION_INTAKE.md.

In order: the bearer token is verified (`401`); the caller is authorised as a staff operator with a
second factor (`401`, `403 forbidden`, `403 mfa-required`); the intake is refused while this
database does not admit it (`503`); then the replay store runs the effect once per
`Idempotency-Key`, and every answer it stores — the `201`, a `409` for a slug already held, a `422`,
a `400` for a body that is not JSON — is replayed as it was. Nothing of the request is logged.
"""

import json
import logging
import re

from django.conf import settings
from django.http import HttpRequest, HttpResponse

from apps.orgs.intake_services import (
    REQUIRED_AMR,
    IntakeActor,
    IntakeOperationReference,
    IntakeRefusedError,
    KeyReused,
    Recorded,
    SlugTaken,
    StaffGrantLostError,
    authorise_intake,
    intake_available,
    intake_operation_reference,
    record_intake,
)
from core import faults
from core.api.idempotency import KEY_HEADER, REUSE, problem, respond_once, timestamp
from core.api.scopes import declares
from core.db.ids import new_uuid7
from core.idempotency.store import StoredResponse
from services.identity.access_tokens import MAX_TOKEN, TokenVerificationError
from services.identity.trusted_issuers import verify_configured_token

from .intake_permissions import CREATE_ORGANISATION
from .intake_serializers import MalformedBodyError, intake_result, parse, validate

REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{8,64}\Z")
LOGGER = logging.getLogger(__name__)
PROBLEM_BASE = "https://kodera.io/problems/"
PROBLEM_TYPE = "application/problem+json"
TITLES = {
    "malformed-request": "Malformed request",
    "unauthenticated": "Authentication required",
    "forbidden": "Access refused",
    "mfa-required": "A second factor is required",
    "method-not-allowed": "Method not allowed",
    "slug-taken": "Slug already held",
    "validation-error": "Validation failed",
    "intake-closed": "Intake not admitted",
    "internal-error": "Internal error",
}


def _document(kind: str, status: int, request_id: str, **extension: object) -> bytes:
    body = {
        "type": PROBLEM_BASE + kind,
        "title": TITLES[kind],
        "status": status,
        "request_id": request_id,
        **extension,
    }
    return json.dumps(body).encode()


def _problem(kind: str, status: int, request_id: str, **extension: object) -> HttpResponse:
    response = HttpResponse(
        _document(kind, status, request_id, **extension), status=status, content_type=PROBLEM_TYPE
    )
    if status == 401:
        response["WWW-Authenticate"] = "Bearer"
    if status == 405:
        response["Allow"] = "POST"
    return response


def _stored(kind: str, status: int, request_id: str, **extension: object) -> StoredResponse:
    return StoredResponse(
        status=status,
        body=_document(kind, status, request_id, **extension),
        content_type=PROBLEM_TYPE,
    )


def _bearer(request: HttpRequest) -> str:
    authorization = request.headers.get("Authorization", "")
    if len(authorization) > MAX_TOKEN + 7:
        raise TokenVerificationError()
    parts = authorization.split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1]:
        raise TokenVerificationError()
    return parts[1]


def _effect(
    request: HttpRequest,
    actor: IntakeActor,
    request_id: str,
    operation_ref: IntakeOperationReference,
) -> StoredResponse:
    """The handler the replay store runs once, inside its transaction. Its last statement is the
    `intake:before-commit` site: past every write of the intake, before the replay entry."""
    response = _answer(request, actor, request_id, operation_ref)
    faults.reach("intake:before-commit")
    return response


def _answer(
    request: HttpRequest,
    actor: IntakeActor,
    request_id: str,
    operation_ref: IntakeOperationReference,
) -> StoredResponse:
    try:
        document = parse(request.body)
    except MalformedBodyError:
        return _stored("malformed-request", 400, request_id)
    validated = validate(document)
    if isinstance(validated, list):
        errors = [{"pointer": error.pointer, "code": error.code} for error in validated]
        return _stored("validation-error", 422, request_id, errors=errors)
    outcome = record_intake(
        actor=actor,
        request=validated,
        request_id=request_id,
        path=request.path,
        idempotency_key=request.headers.get(KEY_HEADER, ""),
        operation_ref=operation_ref,
    )
    if isinstance(outcome, SlugTaken):
        return _stored("slug-taken", 409, request_id)
    if isinstance(outcome, KeyReused):
        return problem(REUSE, request_id, first_seen_at=timestamp(outcome.first_seen_at))
    if isinstance(outcome, Recorded):
        return StoredResponse(
            status=201,
            body=intake_result(outcome.view),
            content_type="application/json",
            location=f"/api/v1/organisations/{outcome.view.organisation_id}",
        )
    raise AssertionError("unreachable: the intake returned no known outcome")


@declares(CREATE_ORGANISATION)
def organisations(request: HttpRequest) -> HttpResponse:
    supplied = request.headers.get("X-Request-Id", "")
    request_id = supplied if REQUEST_ID.fullmatch(supplied) else str(new_uuid7())
    try:
        if request.method != "POST":
            response = _problem("method-not-allowed", 405, request_id, allowed=["POST"])
        else:
            verified, lane = verify_configured_token(
                _bearer(request), trusted=settings.KODERA_AUTH_TRUST
            )
            actor = authorise_intake(verified=verified, lane=lane, request_id=request_id)
            if not intake_available():
                response = _problem("intake-closed", 503, request_id)
            else:
                operation_ref = intake_operation_reference(
                    actor=actor,
                    path=request.path,
                    idempotency_key=request.headers.get(KEY_HEADER, ""),
                )
                response = respond_once(
                    request,
                    issuer=verified.issuer,
                    subject=verified.subject,
                    request_id=request_id,
                    handler=lambda: _effect(request, actor, request_id, operation_ref),
                    operation_ref=operation_ref.value,
                )
                # Committed, and nothing answered yet: a worker's claim is the dispatch
                # (ADR-0004), so this is also `intake:after-commit-before-dispatch`.
                faults.reach("intake:after-commit")
    except TokenVerificationError:
        response = _problem("unauthenticated", 401, request_id)
    except IntakeRefusedError as refused:
        if refused.kind == "unauthenticated":
            response = _problem("unauthenticated", 401, request_id)
        elif refused.kind == "mfa_required":
            response = _problem("mfa-required", 403, request_id, required_amr=list(REQUIRED_AMR))
        else:
            response = _problem("forbidden", 403, request_id)
    except StaffGrantLostError:
        # The grant was revoked between the check and the effect: the effect rolled back and the
        # refusal is not stored, so the key stays usable once the grant is restored.
        response = _problem("forbidden", 403, request_id)
    except Exception as error:
        # SQL diagnostics, credentials, the intended owner's contact and identity data never enter
        # the error body or the logs: the class of the failure and the request id, nothing else.
        LOGGER.error(
            "createOrganisation failed: %s request_id=%s", type(error).__name__, request_id
        )
        response = _problem("internal-error", 500, request_id)
    response["Cache-Control"] = "no-store"
    response["X-Request-Id"] = request_id
    return response
