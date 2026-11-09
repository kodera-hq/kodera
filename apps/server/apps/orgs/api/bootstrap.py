"""GET-only bootstrap status using public trust and the named current-authority exception."""

from uuid import UUID

from django.conf import settings
from django.http import HttpRequest, HttpResponse

from core.api import lanes, problems
from core.api.scopes import declares
from core.db.ids import new_uuid7
from services.identity.access_tokens import TokenVerificationError
from services.identity.trusted_issuers import verify_configured_token

from ..bootstrap_services import read_bootstrap
from .bootstrap_permissions import (
    GET_BOOTSTRAP,
    BootstrapForbiddenError,
    BootstrapNotFoundError,
    BootstrapStaffUnauthenticatedError,
    BootstrapUnknownIdentityError,
)
from .detail import REQUEST_ID, _bearer, _problem


@declares(GET_BOOTSTRAP)
def organisation_bootstrap(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    supplied = request.headers.get("X-Request-Id", "")
    request_id = supplied if REQUEST_ID.fullmatch(supplied) else str(new_uuid7())
    try:
        if request.method != "GET":
            response = _problem(405, request_id)
        else:
            verified, lane = verify_configured_token(
                _bearer(request), trusted=settings.KODERA_AUTH_TRUST
            )
            verified, lane = lanes.admit(verified, lane)
            response = HttpResponse(
                read_bootstrap(
                    verified=verified, lane=lane, target_id=organisation_id, request_id=request_id
                ),
                content_type="application/json",
            )
    except (TokenVerificationError, BootstrapStaffUnauthenticatedError):
        response = _problem(401, request_id)
    except BootstrapUnknownIdentityError:
        response = problems.identity_unknown(request_id, GET_BOOTSTRAP.operation_id)
    except BootstrapForbiddenError:
        response = _problem(403, request_id)
    except BootstrapNotFoundError:
        response = _problem(404, request_id)
    except Exception:
        response = _problem(500, request_id)
    response["Cache-Control"] = "no-store"
    response["X-Request-Id"] = request_id
    return response
