"""createTenant, the route: docs/specs/QUICK_WORKSPACE.md §4.

The bearer token is verified and a staff token refused (staff never accept the customer's
agreements on its behalf), then the caller is authorised against current state, owner only, before
the replay store. While billing is on the request is refused with `409 billing-enabled`, after an
answer the store already holds, which is replayed whatever the switch says (CONVENTIONS.md §8),
and the refusal is never stored. The step itself runs the service in a savepoint, so a refusal
leaves nothing but its stored answer.
"""

import json
import logging
import unicodedata
from collections.abc import Mapping
from typing import Any
from uuid import UUID

from django.conf import settings
from django.db import transaction
from django.http import HttpRequest, HttpResponse

from apps.billing.switch import BillingEnabledError, require_no_billing
from apps.billing.unbilled import (
    REQUIRED_SCOPE,
    Accepted,
    InitialiseForbiddenError,
    InitialiseStateError,
    LegalValidationError,
    LegalVersionError,
    OfferNotConfiguredError,
    TenantExistsError,
    TenantRequest,
    TenantSlugInvalidError,
    TenantSlugTakenError,
    WorkspaceCallerUnknownError,
    WorkspaceNotFoundError,
    authorise,
    create_tenant,
    created_representation,
    free_slugs,
    record_staff_denial,
    record_tenant_denial,
)
from core.api import lanes, problems
from core.api.idempotency import (
    KEY_HEADER,
    MALFORMED,
    PROBLEM_TYPE,
    StoredResponse,
    holds_answer,
    problem,
    respond_once,
)
from core.api.scopes import declares
from core.db.ids import new_uuid7
from services.identity.access_tokens import TokenVerificationError, VerifiedAccessToken
from services.identity.trusted_issuers import verify_configured_token

from .permissions import CREATE_TENANT
from .views import PROBLEM_BASE, REQUEST_ID, _bearer, _problem

LOG = logging.getLogger(__name__)
TITLES = {
    "validation-error": "Validation error",
    "invalid-state-transition": "Invalid state transition",
    "tenant-exists": "Tenant exists",
    "billing-enabled": "Billing enabled",
    "slug-taken": "Slug taken",
    "service-unavailable": "Service unavailable",
}
# The wait a client is told when the deployment has no workspace offer: an operator's fix, not a
# moment's load, so a minute.
NOT_CONFIGURED_RETRY_S = 60
TOP = {"name", "slug", "locale", "legal_acceptances"}
LEGAL = {"code", "version", "locale"}
LOCALES = ("fr", "en")
Errors = list[dict[str, str]]


class TenantRequestError(Exception):
    def __init__(self, errors: Errors) -> None:
        super().__init__("tenant request refused")
        self.errors = errors


def _string(source: Mapping[str, Any], name: str, pointer: str, limit: int, errors: Errors) -> Any:
    if name not in source:
        errors.append({"pointer": f"{pointer}/{name}", "code": "required"})
        return None
    value = source[name]
    if not isinstance(value, str) or len(value) > limit:
        errors.append({"pointer": f"{pointer}/{name}", "code": "type"})
        return None
    return value


def _control(character: str) -> bool:
    """A control, format, surrogate, private-use or unassigned character, or a line or paragraph
    separator; a no-break space, common in French names, is none of these."""
    category = unicodedata.category(character)
    return category.startswith("C") or category in ("Zl", "Zp")


def parse_tenant_request(body: Any) -> TenantRequest:
    """The contract's `TenantCreation`, its shape only: every refusal a `422` entry. The slug's
    pattern and availability and the versions in force are the service's to judge."""
    errors: Errors = []
    for name in sorted(set(body) - TOP):
        errors.append({"pointer": f"/{name}", "code": "unknown_member"})
    name = _string(body, "name", "", 200, errors)
    if name is not None and (not name.strip() or any(_control(c) for c in name)):
        errors.append({"pointer": "/name", "code": "format"})
    slug = body.get("slug")
    if "slug" not in body:
        errors.append({"pointer": "/slug", "code": "required"})
    elif not isinstance(slug, str):
        errors.append({"pointer": "/slug", "code": "type"})
        slug = None
    elif len(slug) > 64:
        # Too long for the pattern, so refused as the pattern refuses it.
        errors.append({"pointer": "/slug", "code": "format"})
        slug = None
    locale = "fr"
    if "locale" in body:
        locale = body["locale"]
        if locale not in LOCALES:
            errors.append({"pointer": "/locale", "code": "type"})
    accepted: dict[str, Accepted] = {}
    raw = body.get("legal_acceptances")
    if "legal_acceptances" not in body:
        errors.append({"pointer": "/legal_acceptances", "code": "required"})
        raw = []
    elif not isinstance(raw, list) or len(raw) != 2:
        errors.append({"pointer": "/legal_acceptances", "code": "type"})
        raw = []
    for index, item in enumerate(raw):
        pointer = f"/legal_acceptances/{index}"
        if not isinstance(item, dict):
            errors.append({"pointer": pointer, "code": "type"})
            continue
        for member in sorted(set(item) - LEGAL):
            errors.append({"pointer": f"{pointer}/{member}", "code": "unknown_member"})
        code = _string(item, "code", pointer, 8, errors)
        version = _string(item, "version", pointer, 20, errors)
        doc_locale = _string(item, "locale", pointer, 2, errors)
        if code is not None and code not in ("cgv", "dpa"):
            errors.append({"pointer": f"{pointer}/code", "code": "unknown_document"})
        elif doc_locale is not None and doc_locale not in LOCALES:
            errors.append({"pointer": f"{pointer}/locale", "code": "type"})
        elif code is not None and code in accepted:
            errors.append({"pointer": "/legal_acceptances", "code": "duplicate_code"})
        elif code is not None and version is not None and doc_locale is not None:
            accepted[code] = Accepted(code=code, version=version, locale=doc_locale)
    if errors or name is None or slug is None or set(accepted) != {"cgv", "dpa"}:
        raise TenantRequestError(errors or [{"pointer": "/legal_acceptances", "code": "type"}])
    return TenantRequest(
        name=name, slug=slug, locale=locale, cgv=accepted["cgv"], dpa=accepted["dpa"]
    )


def _stored(status: int, kind: str, request_id: str, **extension: object) -> StoredResponse:
    title = TITLES[kind]
    body = {
        "type": PROBLEM_BASE + kind,
        "title": title,
        "status": status,
        "request_id": request_id,
        **extension,
    }
    return StoredResponse(status=status, body=json.dumps(body).encode(), content_type=PROBLEM_TYPE)


def _invalid(request_id: str, *errors: dict[str, str]) -> StoredResponse:
    return _stored(422, "validation-error", request_id, errors=list(errors))


def _create_step(
    request: HttpRequest, organisation_id: UUID, verified: VerifiedAccessToken, request_id: str
) -> StoredResponse:
    """The step the replay store runs once per key; its 4xx answers are stored and replayed."""
    if request.content_type != "application/json":
        return problem(MALFORMED, request_id)
    try:
        payload = json.loads(request.body)
    except (ValueError, RecursionError):
        return problem(MALFORMED, request_id)
    if not isinstance(payload, dict):
        return problem(MALFORMED, request_id)
    try:
        tenant_request = parse_tenant_request(payload)
    except TenantRequestError as refused:
        return _invalid(request_id, *refused.errors)
    try:
        # One savepoint: a refusal after the first write keeps none of it.
        with transaction.atomic():
            created = create_tenant(
                verified=verified,
                organisation_id=organisation_id,
                request=tenant_request,
                request_id=request_id,
                source_ip=request.META.get("REMOTE_ADDR"),
                user_agent=request.headers.get("User-Agent"),
            )
    except InitialiseStateError as refused:
        return _stored(
            409,
            "invalid-state-transition",
            request_id,
            allowed_states=list(refused.allowed_states),
        )
    except TenantExistsError:
        return _stored(
            409,
            "tenant-exists",
            request_id,
            detail="The organisation already has its workspace.",
        )
    except TenantSlugInvalidError:
        return _invalid(request_id, {"pointer": "/slug", "code": "format"})
    except TenantSlugTakenError:
        return _stored(409, "slug-taken", request_id, suggestions=free_slugs(tenant_request.slug))
    except LegalVersionError as refused:
        detail = "in force: " + ", ".join(refused.allowed) if refused.allowed else "none in force"
        return _invalid(
            request_id,
            {
                "pointer": "/legal_acceptances",
                "code": f"{refused.code}_not_in_force",
                "detail": detail,
            },
        )
    except LegalValidationError as refused:
        return _invalid(request_id, {"pointer": "/legal_acceptances", "code": refused.reason})
    return StoredResponse(
        status=201,
        body=json.dumps(created_representation(created)).encode(),
        content_type="application/json",
        location=f"/api/v1/tenants/{created.tenant_id}",
    )


def _not_configured(request_id: str) -> HttpResponse:
    body = {
        "type": PROBLEM_BASE + "service-unavailable",
        "title": TITLES["service-unavailable"],
        "status": 503,
        "request_id": request_id,
        "detail": "This deployment has no workspace offer configured.",
        "retry_after_s": NOT_CONFIGURED_RETRY_S,
    }
    response = HttpResponse(json.dumps(body), status=503, content_type=PROBLEM_TYPE)
    response["Retry-After"] = str(NOT_CONFIGURED_RETRY_S)
    return response


def _billing_enabled(request_id: str) -> HttpResponse:
    body = {
        "type": PROBLEM_BASE + "billing-enabled",
        "title": TITLES["billing-enabled"],
        "status": 409,
        "request_id": request_id,
        "detail": "This deployment bills: a tenant is ordered with placeOrder.",
    }
    return HttpResponse(json.dumps(body), status=409, content_type=PROBLEM_TYPE)


def _finish(response: HttpResponse, request_id: str) -> HttpResponse:
    response["Cache-Control"] = "no-store"
    response["X-Request-Id"] = request_id
    return response


@declares(CREATE_TENANT)
def create(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    supplied = request.headers.get("X-Request-Id", "")
    request_id = supplied if REQUEST_ID.fullmatch(supplied) else str(new_uuid7())
    try:
        verified, lane = verify_configured_token(
            _bearer(request), trusted=settings.KODERA_AUTH_TRUST
        )
        verified, lane = lanes.admit(verified, lane)
        if lane == "staff":
            record_staff_denial(
                verified=verified,
                organisation_id=organisation_id,
                request_id=request_id,
                required_scope=REQUIRED_SCOPE,
            )
            return _finish(_problem(403, request_id), request_id)
        # Before the store, so a member is refused 403 and a replay never outlives a removal;
        # the step judges the caller again under the organisation lock.
        authorise(verified=verified, organisation_id=organisation_id)
        # After the caller's role, so a member is refused 403 whatever the switch says; after an
        # answer the store already holds; never stored itself.
        if not holds_answer(
            request,
            issuer=verified.issuer,
            subject=verified.subject,
            key=request.headers.get(KEY_HEADER, ""),
        ):
            require_no_billing()
        response = respond_once(
            request,
            issuer=verified.issuer,
            subject=verified.subject,
            request_id=request_id,
            handler=lambda: _create_step(request, organisation_id, verified, request_id),
        )
    except TokenVerificationError:
        response = _problem(401, request_id)
    except WorkspaceCallerUnknownError:
        response = problems.identity_unknown(request_id, CREATE_TENANT.operation_id)
    except WorkspaceNotFoundError:
        response = _problem(404, request_id)
    except BillingEnabledError:
        response = _billing_enabled(request_id)
    except OfferNotConfiguredError:
        response = _not_configured(request_id)
    except InitialiseForbiddenError as refused:
        try:
            record_tenant_denial(
                refused=refused, request_id=request_id, required_scope=REQUIRED_SCOPE
            )
            response = _problem(403, request_id)
        except Exception as failure:
            LOG.error(
                "createTenant denial not recorded: %s request_id=%s",
                type(failure).__name__,
                request_id,
            )
            response = _problem(500, request_id)
    except Exception as failure:
        # The step rolled back with nothing stored: the same key runs it again. The log names the
        # exception's class and the request id, never the body, a header or the token.
        LOG.error("createTenant failed: %s request_id=%s", type(failure).__name__, request_id)
        response = _problem(500, request_id)
    return _finish(response, request_id)
