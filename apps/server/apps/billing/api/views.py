"""The billing reads: the public catalogue, and an organisation's orders, subscriptions, invoices,
payment link and dunning view (contracts/core-api.openapi.yaml, tags Catalog, Orders and Billing).

The catalogue needs no token (`security: []`). Every other read authenticates the bearer token
against the trust configuration, refuses a staff token with `403` (its lane is not built), and
reads through apps/billing/access.py, which resolves the caller's current membership and role in
the snapshot it reads from. An identifier of another organisation's row answers `404`.
"""

import json
import logging
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from django.conf import settings
from django.http import HttpRequest, HttpResponse

from apps.billing import selectors, services
from apps.billing.access import (
    READERS,
    BillingCallerUnknownError,
    BillingForbiddenError,
    BillingNotFoundError,
    read_as_member,
    record_member_denial,
    record_staff_denial,
)
from apps.billing.callers import require_role, tenant_caller
from apps.billing.pagination import InvalidListQueryError, parse_query
from apps.billing.payments import services as payments
from apps.billing.payments.port import (
    ProviderRefusedError,
    ProviderUnavailableError,
    ReturnUrlRequiredError,
)
from apps.billing.states import TransitionRefusedError
from apps.billing.switch import BillingDisabledError, require_billing
from core.api import lanes, problems
from core.api.idempotency import (
    KEY_HEADER,
    MALFORMED,
    PROBLEM_TYPE,
    StoredResponse,
    holds_answer,
    is_malformed,
    is_missing,
    problem,
    respond_once,
)
from core.api.scopes import Operation, declares
from core.db.ids import new_uuid7
from services.identity.access_tokens import MAX_TOKEN, TokenVerificationError
from services.identity.trusted_issuers import verify_configured_token

from . import permissions as op
from .order_request import OrderRequestError, parse_order_request

REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{8,64}\Z")
PROBLEM_BASE = "https://kodera.io/problems/"
PROBLEMS = {
    400: ("malformed-request", "Malformed request"),
    401: ("unauthenticated", "Authentication required"),
    403: ("forbidden", "Access refused"),
    404: ("not-found", "Not found"),
    405: ("method-not-allowed", "Method not allowed"),
    500: ("internal-error", "Internal error"),
}
LOG = logging.getLogger(__name__)
PERIODS = frozenset({"monthly", "yearly"})
SUBSCRIPTION_STATES = frozenset({"pending", "active", "past_due", "suspended", "cancelled"})
INVOICE_STATES = frozenset({"issued", "paid", "overdue", "void", "credited", "draft"})


def _problem(status: int, request_id: str, *, allow: str = "GET") -> HttpResponse:
    kind, title = PROBLEMS[status]
    body: dict[str, object] = {
        "type": PROBLEM_BASE + kind,
        "title": title,
        "status": status,
        "request_id": request_id,
    }
    if status == 405:
        body["allowed"] = [method.strip() for method in allow.split(",")]
    response = HttpResponse(
        json.dumps(body), status=status, content_type="application/problem+json"
    )
    if status == 401:
        response["WWW-Authenticate"] = "Bearer"
    if status == 405:
        response["Allow"] = allow
    return response


def _conflict(request_id: str, detail: str) -> HttpResponse:
    body = {
        "type": PROBLEM_BASE + "conflict",
        "title": "Conflict",
        "status": 409,
        "request_id": request_id,
        "detail": detail,
    }
    return HttpResponse(json.dumps(body), status=409, content_type="application/problem+json")


def _bearer(request: HttpRequest) -> str:
    authorization = request.headers.get("Authorization", "")
    if len(authorization) > MAX_TOKEN + 7:
        raise TokenVerificationError()
    parts = authorization.split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1]:
        raise TokenVerificationError()
    return parts[1]


def _answer(
    request: HttpRequest, operation: Operation, produce: Callable[[str], Any]
) -> HttpResponse:
    supplied = request.headers.get("X-Request-Id", "")
    request_id = supplied if REQUEST_ID.fullmatch(supplied) else str(new_uuid7())
    try:
        if request.method != "GET":
            response = _problem(405, request_id)
        else:
            response = HttpResponse(
                json.dumps(produce(request_id)), content_type="application/json"
            )
    except InvalidListQueryError:
        response = _problem(400, request_id)
    except TokenVerificationError:
        response = _problem(401, request_id)
    except BillingCallerUnknownError:
        response = problems.identity_unknown(request_id, operation.operation_id)
    except _RefusedError:
        response = _problem(403, request_id)
    except BillingNotFoundError:
        response = _problem(404, request_id)
    except selectors.InvoicePdfNotRenderedError:
        response = _conflict(request_id, "The invoice has no rendered PDF to download.")
    except Exception as failure:
        # SQL diagnostics, credentials and identity data never enter the error body or logs.
        LOG.error(
            "%s failed: %s request_id=%s",
            operation.operation_id,
            type(failure).__name__,
            request_id,
        )
        response = _problem(500, request_id)
    response["Cache-Control"] = "no-store"
    response["X-Request-Id"] = request_id
    return response


class _RefusedError(Exception):
    """A `403` already recorded."""


def _member_read(
    request: HttpRequest,
    request_id: str,
    *,
    organisation: Callable[[], UUID | None],
    scope: str,
    target_urn: str,
    read: Callable[[], Any],
    allow_community: bool = False,
) -> Any:
    """Authenticate, refuse the staff lane, then read as a member: in that order, so neither an
    unknown caller nor a staff token can tell an existing identifier from an absent one."""
    verified, lane = verify_configured_token(_bearer(request), trusted=settings.KODERA_AUTH_TRUST)
    verified, lane = lanes.admit(verified, lane)
    from apps.billing.access import is_shared_community

    shared = (
        allow_community and (owner := organisation()) is not None and is_shared_community(owner)
    )
    if lane == "staff" and not shared:
        record_staff_denial(
            verified=verified, target_urn=target_urn, request_id=request_id, scope=scope
        )
        raise _RefusedError()
    try:
        found = read_as_member(
            verified=verified,
            organisation=organisation,
            scope=scope,
            read=lambda _: read(),
            allow_community=shared,
        )
    except BillingForbiddenError as refused:
        record_member_denial(refused=refused, target_urn=target_urn, request_id=request_id)
        raise _RefusedError() from None
    if found is None:
        raise BillingNotFoundError()
    return found


def _catalogue(operation: Operation, filters: dict[str, frozenset[str] | None], read: Any) -> Any:
    @declares(operation)
    def view(request: HttpRequest) -> HttpResponse:
        return _answer(
            request,
            operation,
            lambda _: read(
                parse_query(
                    request.META.get("QUERY_STRING", ""),
                    operation=operation.operation_id,
                    scope="",
                    filters=filters,
                )
            ),
        )

    return view


plans = _catalogue(
    op.LIST_PLANS, {"state": frozenset({"draft", "published", "retired"})}, selectors.list_plans
)
packs = _catalogue(op.LIST_PACKS, {}, selectors.list_packs)
capacity_tiers = _catalogue(
    op.LIST_CAPACITY_TIERS, {"pack_code": None}, selectors.list_capacity_tiers
)
prices = _catalogue(
    op.LIST_PRICES,
    {"pack_code": None, "capacity_tier_code": None, "billing_period": PERIODS},
    selectors.list_prices,
)


def _organisation_list(
    operation: Operation,
    scope: str,
    filters: dict[str, frozenset[str] | None],
    read: Any,
    *,
    allow_community: bool = False,
) -> Any:
    @declares(operation)
    def view(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
        def produce(request_id: str) -> Any:
            # The query is read once the caller is authorised: an unauthenticated caller gets 401.
            def page() -> Any:
                query = parse_query(
                    request.META.get("QUERY_STRING", ""),
                    operation=operation.operation_id,
                    scope=str(organisation_id),
                    filters=filters,
                )
                return read(organisation_id=organisation_id, query=query)

            return _member_read(
                request,
                request_id,
                organisation=lambda: organisation_id,
                scope=scope,
                target_urn=f"urn:kodera:organisation:{organisation_id}",
                read=page,
                allow_community=allow_community,
            )

        return _answer(request, operation, produce)

    return view


subscriptions = _organisation_list(
    op.LIST_SUBSCRIPTIONS,
    "subscription:read",
    {"state": SUBSCRIPTION_STATES},
    selectors.list_subscriptions,
)
invoices = _organisation_list(
    op.LIST_INVOICES, "invoice:read", {"state": INVOICE_STATES}, selectors.list_invoices
)
credit_notes = _organisation_list(
    op.LIST_CREDIT_NOTES, "invoice:read", {}, selectors.list_credit_notes
)


def _resource(operation: Operation, scope: str, kind: str, owner: Any, read: Any) -> Any:
    """GET of one row by id: its organisation is the row's, and the caller must be a member."""

    @declares(operation)
    def view(request: HttpRequest, **path: UUID) -> HttpResponse:
        (row_id,) = path.values()

        def produce(request_id: str) -> Any:
            found: dict[str, UUID | None] = {}

            def organisation() -> UUID | None:
                found["organisation_id"] = owner(row_id)
                return found["organisation_id"]

            return _member_read(
                request,
                request_id,
                organisation=organisation,
                scope=scope,
                target_urn=f"urn:kodera:{kind}:{row_id}",
                read=lambda: read(found["organisation_id"], row_id),
            )

        return _answer(request, operation, produce)

    return view


order = _resource(
    op.GET_ORDER,
    "order:read",
    "order",
    selectors.order_owner,
    lambda org, row: selectors.get_order(organisation_id=org, order_id=row),
)
subscription = _resource(
    op.GET_SUBSCRIPTION,
    "subscription:read",
    "subscription",
    selectors.subscription_owner,
    lambda org, row: selectors.get_subscription(organisation_id=org, subscription_id=row),
)
invoice = _resource(
    op.GET_INVOICE,
    "invoice:read",
    "invoice",
    selectors.invoice_owner,
    lambda org, row: selectors.get_invoice(organisation_id=org, invoice_id=row),
)
credit_note = _resource(
    op.GET_CREDIT_NOTE,
    "invoice:read",
    "credit_note",
    selectors.credit_note_owner,
    lambda org, row: selectors.get_credit_note(organisation_id=org, credit_note_id=row),
)
_get_payment_link = _resource(
    op.GET_PAYMENT_LINK,
    "payment:read",
    "invoice",
    selectors.invoice_owner,
    lambda org, row: selectors.get_payment_link(organisation_id=org, invoice_id=row),
)
invoice_download = _resource(
    op.GET_INVOICE_DOWNLOAD_LINK,
    "invoice:read",
    "invoice",
    selectors.invoice_owner,
    lambda org, row: selectors.invoice_download_link(organisation_id=org, invoice_id=row),
)

dunning = _resource(
    op.GET_DUNNING,
    "subscription:read",
    "organisation",
    lambda organisation_id: organisation_id,
    lambda organisation_id, _: selectors.dunning_view(organisation_id),
)


# --- placeOrder ---------------------------------------------------------------------------------


def _billing_disabled(request_id: str) -> HttpResponse:
    """`409 billing-disabled` (QUICK_WORKSPACE.md §2.2): this deployment does not bill, so nothing
    that charges runs. Never stored against the key: the same request is answered on its merits
    once billing is on again."""
    body = {
        "type": PROBLEM_BASE + "billing-disabled",
        "title": "Billing disabled",
        "status": 409,
        "request_id": request_id,
        "detail": "This deployment does not bill: no new order or payment link is created.",
    }
    return HttpResponse(json.dumps(body), status=409, content_type="application/problem+json")


def _stored_problem(
    status: int, kind: str, title: str, request_id: str, **extension: object
) -> StoredResponse:
    body = {
        "type": PROBLEM_BASE + kind,
        "title": title,
        "status": status,
        "request_id": request_id,
        **extension,
    }
    return StoredResponse(status=status, body=json.dumps(body).encode(), content_type=PROBLEM_TYPE)


def _invalid(request_id: str, *errors: dict[str, str]) -> StoredResponse:
    return _stored_problem(
        422, "validation-error", "Validation error", request_id, errors=list(errors)
    )


def _place_step(
    request: HttpRequest, organisation_id: UUID, verified: Any, request_id: str
) -> StoredResponse:
    """The step the replay store runs once per key; its 4xx answers are stored and replayed."""
    if request.content_type != "application/json":
        return problem(MALFORMED, request_id)
    try:
        payload = json.loads(request.body)
    except ValueError:
        return problem(MALFORMED, request_id)
    if not isinstance(payload, dict):
        return problem(MALFORMED, request_id)
    try:
        order_request = parse_order_request(payload)
    except OrderRequestError as refused:
        return _invalid(request_id, *refused.errors)
    try:
        placed = services.place_order(
            verified=verified,
            organisation_id=organisation_id,
            idempotency_key=request.headers.get("Idempotency-Key", ""),
            request=order_request,
            request_id=request_id,
            source_ip=request.META.get("REMOTE_ADDR"),
            user_agent=request.headers.get("User-Agent"),
        )
    except services.BillingValidationError as refused:
        return _invalid(
            request_id, {"pointer": "/" + refused.field.replace(".", "/"), "code": refused.reason}
        )
    except services.LegalValidationError as refused:
        return _invalid(request_id, {"pointer": "/" + refused.field, "code": refused.reason})
    except services.LegalVersionError as refused:
        pointer = "/dpa_acceptance/dpa_id" if refused.code == "dpa" else "/legal_acceptances"
        detail = "in force: " + ", ".join(refused.allowed) if refused.allowed else "none in force"
        return _invalid(
            request_id,
            {"pointer": pointer, "code": f"{refused.code}_not_in_force", "detail": detail},
        )
    except services.DpaNotFoundError:
        return _invalid(request_id, {"pointer": "/dpa_acceptance/dpa_id", "code": "unknown"})
    except services.TenantSlugInvalidError:
        return _invalid(request_id, {"pointer": "/tenant/slug", "code": "format"})
    except services.TenantSlugTakenError:
        return _stored_problem(409, "slug-taken", "Slug taken", request_id)
    except services.OrganisationNotOrderableError:
        return _stored_problem(
            409,
            "invalid-state-transition",
            "Invalid state transition",
            request_id,
            allowed_states=["active"],
        )
    except services.IdempotencyKeyReuseError:
        return _stored_problem(
            409, "idempotency-key-reuse", "Idempotency key reused with a different body", request_id
        )
    except services.OrderInProgressError:
        return _stored_problem(
            409,
            "order-in-progress",
            "Order in progress",
            request_id,
            detail="The organisation has an order placed and not yet paid: pay or cancel it first.",
        )
    return StoredResponse(
        status=201,
        body=json.dumps(services.order_result(placed)).encode(),
        content_type="application/json",
        location=f"/api/v1/orders/{placed.order.id}",
    )


def _place(request: HttpRequest, organisation_id: UUID, request_id: str) -> HttpResponse:
    verified, lane = verify_configured_token(_bearer(request), trusted=settings.KODERA_AUTH_TRUST)
    verified, lane = lanes.admit(verified, lane)
    target = f"urn:kodera:organisation:{organisation_id}"
    if lane == "staff":
        # Staff never accept the customer's agreements on its behalf: no staff role places an order.
        record_staff_denial(
            verified=verified, target_urn=target, request_id=request_id, scope="order:create"
        )
        raise _RefusedError()
    try:
        read_as_member(
            verified=verified,
            organisation=lambda: organisation_id,
            scope="order:create",
            read=lambda _: None,
        )
    except BillingForbiddenError as refused:
        record_member_denial(refused=refused, target_urn=target, request_id=request_id)
        raise _RefusedError() from None
    # After the caller's role, so each refusal is judged and audited as billing on judges it; after
    # an answer the store already holds, which is replayed whatever the switch says (CONVENTIONS.md
    # §8); and never stored itself, so the same request is judged afresh once billing is on.
    if not holds_answer(
        request,
        issuer=verified.issuer,
        subject=verified.subject,
        key=request.headers.get(KEY_HEADER, ""),
    ):
        require_billing()
    return respond_once(
        request,
        issuer=verified.issuer,
        subject=verified.subject,
        request_id=request_id,
        handler=lambda: _place_step(request, organisation_id, verified, request_id),
    )


_list_orders = _organisation_list(op.LIST_ORDERS, "order:read", {}, selectors.list_orders)


@declares(op.LIST_ORDERS, op.PLACE_ORDER)
def orders(request: HttpRequest, organisation_id: UUID) -> HttpResponse:
    if request.method != "POST":
        listed: HttpResponse = _list_orders(request, organisation_id=organisation_id)
        return listed
    supplied = request.headers.get("X-Request-Id", "")
    request_id = supplied if REQUEST_ID.fullmatch(supplied) else str(new_uuid7())
    try:
        response = _place(request, organisation_id, request_id)
    except BillingForbiddenError as refused:
        # The role was lost between the check and the step: refused and recorded, never a 5xx.
        record_member_denial(
            refused=refused,
            target_urn=f"urn:kodera:organisation:{organisation_id}",
            request_id=request_id,
        )
        response = _problem(403, request_id)
    except TokenVerificationError:
        response = _problem(401, request_id)
    except BillingCallerUnknownError:
        response = problems.identity_unknown(request_id, op.PLACE_ORDER.operation_id)
    except _RefusedError:
        response = _problem(403, request_id)
    except BillingNotFoundError:
        response = _problem(404, request_id)
    except BillingDisabledError:
        response = _billing_disabled(request_id)
    except Exception as failure:
        # The step rolled back with nothing stored: the same key runs it again. The log names the
        # exception's class and the request id, never the body, a header or the token.
        LOG.error("placeOrder failed: %s request_id=%s", type(failure).__name__, request_id)
        response = _problem(500, request_id)
    response["Cache-Control"] = "no-store"
    response["X-Request-Id"] = request_id
    return response


# --- cancelOrder --------------------------------------------------------------------------------


def _cancel_step(order_id: UUID, verified: Any, request_id: str) -> StoredResponse:
    """The step the replay store runs once per key; its 409 answers are stored and replayed."""
    try:
        cancelled = services.cancel_order(
            verified=verified, order_id=order_id, request_id=request_id
        )
    except TransitionRefusedError:
        return _stored_problem(
            409,
            "invalid-state-transition",
            "Invalid state transition",
            request_id,
            allowed_states=list(services.IN_FLIGHT),
        )
    except services.OrderInvoiceIssuedError:
        return _stored_problem(
            409,
            "invoice-issued",
            "Invoice payment held",
            request_id,
            detail="A payment for the order's invoice is received or settling: it is not credited.",
        )
    return StoredResponse(
        status=200,
        body=json.dumps(
            selectors.get_order(organisation_id=cancelled.organisation_id, order_id=cancelled.id)
        ).encode(),
        content_type="application/json",
    )


@declares(op.CANCEL_ORDER)
def cancel_order(request: HttpRequest, order_id: UUID) -> HttpResponse:
    supplied = request.headers.get("X-Request-Id", "")
    request_id = supplied if REQUEST_ID.fullmatch(supplied) else str(new_uuid7())
    target = f"urn:kodera:order:{order_id}"
    try:
        if request.method != "POST":
            response = _problem(405, request_id, allow="POST")
        else:
            verified, lane = verify_configured_token(
                _bearer(request), trusted=settings.KODERA_AUTH_TRUST
            )
            verified, lane = lanes.admit(verified, lane)
            if lane == "staff":
                # The order carries the customer's agreements: staff neither place nor cancel it.
                record_staff_denial(
                    verified=verified, target_urn=target, request_id=request_id, scope="order:act"
                )
                raise _RefusedError()
            try:
                read_as_member(
                    verified=verified,
                    organisation=lambda: selectors.order_owner(order_id),
                    scope="order:act",
                    read=lambda _: None,
                )
            except BillingForbiddenError as refused:
                record_member_denial(refused=refused, target_urn=target, request_id=request_id)
                raise _RefusedError() from None
            response = respond_once(
                request,
                issuer=verified.issuer,
                subject=verified.subject,
                request_id=request_id,
                handler=lambda: _cancel_step(order_id, verified, request_id),
            )
    except BillingForbiddenError as refused:
        # The role was lost between the check and the step: refused and recorded, never a 5xx.
        record_member_denial(refused=refused, target_urn=target, request_id=request_id)
        response = _problem(403, request_id)
    except TokenVerificationError:
        response = _problem(401, request_id)
    except BillingCallerUnknownError:
        response = problems.identity_unknown(request_id, op.CANCEL_ORDER.operation_id)
    except _RefusedError:
        response = _problem(403, request_id)
    except BillingNotFoundError:
        response = _problem(404, request_id)
    except Exception as failure:
        # The step rolled back with nothing stored: the same key runs it again.
        LOG.error("cancelOrder failed: %s request_id=%s", type(failure).__name__, request_id)
        response = _problem(500, request_id)
    response["Cache-Control"] = "no-store"
    response["X-Request-Id"] = request_id
    return response


# --- createPaymentLink --------------------------------------------------------------------------

LINK_LOCALES = frozenset({"fr", "en"})
MAX_RETURN_URL = 2048
UPSTREAM_RETRY_AFTER_S = 30


@dataclass(frozen=True, slots=True)
class _LinkBody:
    return_url: str | None
    locale: str


def _link_body(request: HttpRequest, request_id: str) -> _LinkBody | StoredResponse:
    """The optional `PaymentLinkCreateRequest`, or the `400` the replay store keeps for it."""
    if not request.body:
        return _LinkBody(return_url=None, locale="fr")
    if request.content_type != "application/json":
        return problem(MALFORMED, request_id)
    try:
        payload = json.loads(request.body)
    except ValueError:
        return problem(MALFORMED, request_id)
    if not isinstance(payload, dict) or not set(payload) <= {"return_url", "locale"}:
        return problem(MALFORMED, request_id)
    return_url = payload.get("return_url")
    locale = payload.get("locale", "fr")
    if return_url is not None and (
        not isinstance(return_url, str) or not return_url or len(return_url) > MAX_RETURN_URL
    ):
        return _malformed_field(request_id, "/return_url", "format")
    if not isinstance(locale, str) or locale not in LINK_LOCALES:
        return _malformed_field(request_id, "/locale", "enum")
    return _LinkBody(return_url=return_url, locale=locale)


def _malformed_field(request_id: str, pointer: str, code: str) -> StoredResponse:
    return _stored_problem(
        400,
        "malformed-request",
        "Malformed request",
        request_id,
        errors=[{"pointer": pointer, "code": code}],
    )


def _link_step(
    invoice_id: UUID,
    organisation_id: UUID,
    verified: Any,
    body: _LinkBody | StoredResponse,
    issued: payments.IssuedLink | None,
    request_id: str,
) -> StoredResponse:
    """The step the replay store runs once per key: it records the link `issue_link` obtained (or
    returns the invoice's active one) and never calls the provider (IDEMPOTENCY_REPLAY.md §3)."""
    if isinstance(body, StoredResponse):
        return body
    # The provider may have taken seconds: the caller's role is read again in the step's own
    # transaction, so a member demoted meanwhile is refused (`403`, recorded) and stores nothing.
    caller = tenant_caller(verified=verified, organisation_id=organisation_id)
    require_role(caller, roles=READERS["payment:create"], scope="payment:create")
    try:
        payments.record_link(invoice_id=invoice_id, organisation_id=organisation_id, issued=issued)
    except payments.InvoiceNotFoundError:
        return _stored_problem(404, "not-found", "Not found", request_id)
    except payments.InvoiceNotPayableError:
        return _stored_problem(
            409,
            "invalid-state-transition",
            "Invalid state transition",
            request_id,
            allowed_states=list(payments.PAYABLE),
        )
    except payments.PaymentInFlightError:
        return _stored_problem(
            409,
            "conflict",
            "Conflict",
            request_id,
            detail="A payment of the invoice is settling: no second link until it settles.",
        )
    except payments.LinkNotIssuedError:
        if issued is None:
            # Nothing was issued for an invoice that now needs a link (its active link expired
            # meanwhile, say): transient, so a `5xx` that no replay keeps, and a retry issues one.
            raise
        # The invoice moved while the provider answered (a partial payment, say), so the link it
        # issued is withdrawn: the next press, with a new key, asks for what is owed now.
        return _stored_problem(
            409,
            "conflict",
            "Conflict",
            request_id,
            detail="The invoice changed while the link was being created: ask again.",
        )
    link = selectors.get_payment_link(organisation_id=organisation_id, invoice_id=invoice_id)
    if link is None:
        raise RuntimeError("the recorded payment link is not readable")
    return StoredResponse(
        status=201, body=json.dumps(link).encode(), content_type="application/json"
    )


def _upstream_unavailable(request_id: str) -> HttpResponse:
    body = {
        "type": PROBLEM_BASE + "upstream-unavailable",
        "title": "Upstream unavailable",
        "status": 502,
        "request_id": request_id,
        "retry_after_s": UPSTREAM_RETRY_AFTER_S,
    }
    response = HttpResponse(json.dumps(body), status=502, content_type="application/problem+json")
    response["Retry-After"] = str(UPSTREAM_RETRY_AFTER_S)
    return response


def _create_link(request: HttpRequest, invoice_id: UUID, request_id: str) -> HttpResponse:
    """Authorise, obtain the provider's link outside any transaction, then record it through the
    replay store, and withdraw at the provider a link that ended up recorded nowhere."""
    target = f"urn:kodera:invoice:{invoice_id}"
    verified, lane = verify_configured_token(_bearer(request), trusted=settings.KODERA_AUTH_TRUST)
    verified, lane = lanes.admit(verified, lane)
    if lane == "staff":
        # A payment link is the customer's: no staff role creates one (the contract's roles).
        record_staff_denial(
            verified=verified, target_urn=target, request_id=request_id, scope="payment:create"
        )
        raise _RefusedError()
    found: dict[str, UUID | None] = {}

    def organisation() -> UUID | None:
        found["organisation_id"] = selectors.invoice_owner(invoice_id)
        return found["organisation_id"]

    try:
        read_as_member(
            verified=verified,
            organisation=organisation,
            scope="payment:create",
            read=lambda _: None,
        )
    except BillingForbiddenError as refused:
        record_member_denial(refused=refused, target_urn=target, request_id=request_id)
        raise _RefusedError() from None
    organisation_id = found["organisation_id"]
    if organisation_id is None:
        raise BillingNotFoundError()
    # After the caller and the invoice, before the provider; an answer the store already holds is
    # replayed whatever the switch says, and the refusal is never stored (QUICK_WORKSPACE.md §2.2).
    if not holds_answer(
        request,
        issuer=verified.issuer,
        subject=verified.subject,
        key=request.headers.get(KEY_HEADER, ""),
    ):
        require_billing()
    body = _link_body(request, request_id)
    issued: payments.IssuedLink | None = None
    key = request.headers.get(KEY_HEADER, "")
    try:
        # A request the replay store will refuse for its key, or answer from what it holds (a
        # replay, a reuse), never reaches the provider.
        if (
            isinstance(body, _LinkBody)
            and not (is_missing(key) or is_malformed(key))
            and not holds_answer(request, issuer=verified.issuer, subject=verified.subject, key=key)
        ):
            try:
                issued = payments.issue_link(
                    invoice_id=invoice_id,
                    organisation_id=organisation_id,
                    return_url=body.return_url,
                    locale=body.locale,
                )
            except payments.ReturnUrlRefusedError:
                body = _malformed_field(request_id, "/return_url", "origin")
            except ReturnUrlRequiredError:
                body = _malformed_field(request_id, "/return_url", "required")
        return respond_once(
            request,
            issuer=verified.issuer,
            subject=verified.subject,
            request_id=request_id,
            handler=lambda: _link_step(
                invoice_id, organisation_id, verified, body, issued, request_id
            ),
        )
    finally:
        if issued is not None:
            payments.withdraw_unrecorded(issued)


@declares(op.GET_PAYMENT_LINK, op.CREATE_PAYMENT_LINK)
def payment_link(request: HttpRequest, invoice_id: UUID) -> HttpResponse:
    if request.method != "POST":
        read: HttpResponse = _get_payment_link(request, invoice_id=invoice_id)
        return read
    supplied = request.headers.get("X-Request-Id", "")
    request_id = supplied if REQUEST_ID.fullmatch(supplied) else str(new_uuid7())
    target = f"urn:kodera:invoice:{invoice_id}"
    try:
        response = _create_link(request, invoice_id, request_id)
    except BillingForbiddenError as refused:
        # The role was lost between the check and the step: refused and recorded, never a 5xx.
        record_member_denial(refused=refused, target_urn=target, request_id=request_id)
        response = _problem(403, request_id)
    except TokenVerificationError:
        response = _problem(401, request_id)
    except BillingCallerUnknownError:
        response = problems.identity_unknown(request_id, op.CREATE_PAYMENT_LINK.operation_id)
    except _RefusedError:
        response = _problem(403, request_id)
    except BillingNotFoundError:
        response = _problem(404, request_id)
    except BillingDisabledError:
        response = _billing_disabled(request_id)
    except ProviderUnavailableError:
        # No provider is configured, or it did not answer: nothing was issued or stored.
        response = _upstream_unavailable(request_id)
    except ProviderRefusedError as refused:
        # The provider refused the request (a revoked or under-scoped key, say): a configuration
        # error, answered as the upstream's. The log names its status and code, never a message.
        LOG.error(
            "createPaymentLink refused by the provider: %s status=%s code=%s request_id=%s",
            type(refused).__name__,
            getattr(refused, "status", None),
            getattr(refused, "code", None),
            request_id,
        )
        response = _upstream_unavailable(request_id)
    except Exception as failure:
        # Nothing stored: the same key runs it again. The log names the class and the request id.
        LOG.error("createPaymentLink failed: %s request_id=%s", type(failure).__name__, request_id)
        response = _problem(500, request_id)
    response["Cache-Control"] = "no-store"
    response["X-Request-Id"] = request_id
    return response
