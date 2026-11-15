# SPDX-License-Identifier: LicenseRef-Kodera-EE
"""HTTP runtime router for Enterprise commercial billing (`ee/billing/api.py`).

Security & edition invariants:
1. Open-core boundary: every route returns HTTP `404` (`application/problem+json`) unless
   `KODERA_EDITION` normalizes to `enterprise`.
2. Mandatory Bearer authentication & tenant RBAC:
   - Missing or invalid `Authorization: Bearer <token>` -> `401` (`WWW-Authenticate: Bearer`).
   - `/warm-pool` and `/warm-pool/replenish` -> `staff` principal only (`403` otherwise).
   - `/plans` -> authenticated `staff` or active `customer` (`403` otherwise).
   - `/quotes`, `/warm-pool/claim`, `/purchase-orders*` -> `staff` OR active customer holding
     commercial authority (`org_owner`, `org_admin`, `org_billing`) in the target
     `organisation_id`; customer countersignature (`countersign`) requires `staff` or explicit
     billing/owner authority (`org_owner`, `org_billing`), while financial ledger settlement
     transitions (`invoice`, `pay`) are strictly restricted to `staff` or internal operator
     authority (`X-Kodera-Internal-Token`) and verified against persisted Core `billing_invoice`
     and `billing_payment` rows.
3. Zero stack-trace or exception text exposure: HTTP error bodies map domain error codes strictly
   through compile-time constant dictionaries.
"""

from __future__ import annotations

import hmac
import json
import os
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, cast

from . import is_enterprise_edition
from .pricing import (
    MarginFloorViolationError,
    PricingValidationError,
    commercial_schedule_summary,
    quote_plan,
)
from .purchase_orders import (
    CommitmentExceededError,
    InvalidPurchaseOrderTransitionError,
    PurchaseOrder,
    PurchaseOrderBook,
    PurchaseOrderForbiddenError,
    PurchaseOrderNotFoundError,
    PurchaseOrderValidationError,
)
from .storage import (
    BillingAuthorityConflictError,
    BillingAuthorityForbiddenError,
    CallerAuthority,
    StorageBackend,
    verify_caller_authority,
)
from .warm_pool import (
    PoolWatermarks,
    WarmPoolController,
    WarmPoolExhaustedError,
    WarmPoolIdempotencyConflictError,
    WarmPoolTransitionError,
    WarmPoolValidationError,
)

MAX_BODY_BYTES = 32 * 1024
MAX_BEARER_HEADER_BYTES = 8 * 1024
_PO_PREFIX = "/api/v1/ee/billing/purchase-orders/"
_PO_ID_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")

_ORG_COMMERCIAL_ROLES = frozenset(
    {"org_owner", "org_admin", "org_billing", "owner", "admin", "billing_admin"}
)
_ORG_SETTLEMENT_ROLES = frozenset({"org_owner", "org_billing", "owner", "billing_admin"})
_ALL_ORG_MEMBER_ROLES = frozenset(
    {
        "org_owner",
        "org_admin",
        "org_billing",
        "org_member",
        "owner",
        "admin",
        "billing_admin",
        "member",
    }
)
_STAFF_MUTATION_ROLES = frozenset({"staff_operator"})
_STAFF_READ_ROLES = frozenset({"staff_operator", "staff_support"})

_VALIDATION_MESSAGES: dict[str, str] = {
    "pricing_validation_error": "Commercial pricing input failed validation.",
    "margin_floor_violation": "Commercial quote falls below the minimum 44.0% gross-margin floor.",
    "negative_amount": "Monetary amount must be non-negative.",
    "invalid_bps": "Basis-point rate must be between 0 and 10000.",
    "negative_cogs": "Estimated COGS amount must be non-negative.",
    "invalid_seats": "Seat count must be between 1 and 100000.",
    "unknown_plan_code": "Unsupported commercial plan code.",
    "invalid_billing_cycle": "Billing cycle must be monthly or annual.",
    "invalid_discount_bps": "Discount basis points must be between 0 and 10000.",
    "invalid_vat_rate_bps": "VAT basis points must be between 0 and 10000.",
    "negative_custom_net": "Custom net amount must be non-negative.",
    "community_nonzero_charge": "Community plan carries zero commercial charge.",
    "warm_pool_validation_error": "Warm-pool request parameters failed validation.",
    "invalid_min_ready": "Warm-pool minimum ready watermark must be non-negative.",
    "invalid_target_ready": "Warm-pool target ready watermark must be at least min_ready.",
    "invalid_max_total": "Warm-pool maximum capacity must be at least target_ready.",
    "invalid_identifier": "Identifier format is invalid.",
    "invalid_unhealthy_reason": "Unhealthy quarantine reason must be 1 to 200 characters.",
    "invalid_idempotency_key": "Idempotency-Key must be 8 to 255 printable ASCII characters.",
    "unknown_slot_id": "Unknown warm-pool slot identifier.",
    "purchase_order_validation_error": "Purchase order payload failed validation.",
    "invalid_invoice_ref": "Invoice reference must match canonical legal format INV-<SERIES>-<YYYY>-<NNNNN>.",
    "invalid_organisation_id": "Organisation identifier format is invalid.",
    "invalid_customer_po_reference": "Customer purchase order reference format is invalid.",
    "invalid_plan_code": "Enterprise purchase orders require plan_code team or sovereign.",
    "invalid_billing_months": "Billing commitment months must be 1, 12, 24, or 36.",
    "invalid_committed_seats": "Committed seats must be between 1 and 100000.",
    "invalid_committed_storage": "Committed storage must be between 1 and 1000000 GB.",
    "invalid_subtotal": "Purchase order subtotal must be strictly positive.",
    "invalid_expiry": "Purchase order expiration must be strictly after creation time.",
    "invalid_signatory": "Signatory must be 2 to 120 non-blank characters.",
    "duplicate_invoice_ref": "Invoice reference is already bound to another purchase order.",
    "invalid_payment_ref": "Payment reference must be 3 to 128 non-blank characters.",
    "mismatched_invoice_ref": "Invoice reference does not match the bound purchase order invoice.",
    "mismatched_payment_amount": "Paid amount must equal the purchase order total including VAT.",
    "unverified_core_invoice": "Invoice reference does not match a persisted Core invoice for this purchase order.",
    "unverified_core_payment": "Payment reference does not match a settled Core payment for the bound invoice.",
    "negative_usage_metrics": "Seat and storage usage metrics must be non-negative.",
}

_CONFLICT_MESSAGES: dict[str, str] = {
    "purchase_order_invalid_transition": "Purchase order transition is not permitted from its current state.",
    "purchase_order_commitment_exceeded": "Active seat or storage usage exceeds contracted purchase order commitments.",
    "warm_pool_idempotency_conflict": "Idempotency-Key is already bound to a different warm-pool claim.",
    "warm_pool_invalid_transition": "Warm-pool slot state transition is not permitted.",
    "authority_conflict": "Concurrent authority or privacy cutoff transition in progress.",
}

_UNAVAILABLE_MESSAGES: dict[str, str] = {
    "warm_pool_exhausted": "No ready warm-pool slot is currently available for checkout claim.",
}


class BillingUnauthenticatedError(Exception):
    """Missing, malformed, or unverifiable Bearer token (`401 unauthenticated`)."""


class BillingForbiddenError(Exception):
    """Authenticated token lacks authority for the requested resource (`403 forbidden`)."""


@dataclass(frozen=True, slots=True)
class BillingPrincipal:
    """Verified Enterprise billing caller resolved from OIDC Bearer or internal operator token."""

    lane: Literal["staff", "internal", "customer"]
    identity_id: str
    org_roles: Mapping[str, str] = field(default_factory=dict)
    staff_roles: frozenset[str] = field(default_factory=frozenset)
    user_id: str | None = None
    issuer: str | None = None
    subject: str | None = None
    live_authority: bool = False

    def has_org_role(self, organisation_id: str, allowed_roles: frozenset[str]) -> bool:
        if not organisation_id:
            return False
        role = self.org_roles.get(organisation_id)
        return role is not None and role in allowed_roles

    def has_staff_role(self, allowed_roles: frozenset[str]) -> bool:
        return bool(self.staff_roles & allowed_roles)


def _to_caller_authority(
    principal: BillingPrincipal,
    allowed_org_roles: frozenset[str] = _ORG_COMMERCIAL_ROLES,
    *,
    allowed_staff_roles: frozenset[str] = _STAFF_MUTATION_ROLES,
) -> CallerAuthority:
    return CallerAuthority(
        lane=principal.lane,
        identity_id=principal.identity_id,
        user_id=principal.user_id,
        issuer=principal.issuer,
        subject=principal.subject,
        allowed_org_roles=allowed_org_roles,
        static_org_roles=principal.org_roles,
        allowed_staff_roles=allowed_staff_roles,
        static_staff_roles=principal.staff_roles,
        live_authority=principal.live_authority,
    )


Authenticator = Callable[[Mapping[str, str]], BillingPrincipal]


def _configured_internal_token(environ: Mapping[str, str] | None = None) -> str | None:
    source = environ if environ is not None else os.environ
    raw = source.get("KODERA_EE_INTERNAL_TOKEN")
    if raw is None:
        try:
            from django.conf import settings

            if settings.configured:
                raw = getattr(settings, "KODERA_EE_INTERNAL_TOKEN", None)
        except ImportError:
            raw = None
    if not isinstance(raw, str) or not (32 <= len(raw) <= 512):
        return None
    if any(ord(ch) < 0x21 or ord(ch) > 0x7E for ch in raw):
        return None
    return raw


def authenticate_bearer_header(
    req_headers: Mapping[str, str],
    *,
    environ: Mapping[str, str] | None = None,
) -> BillingPrincipal:
    """Verify internal operator token or `Authorization: Bearer <token>` against Core OIDC trust."""
    if "x-kodera-internal-token" in req_headers:
        supplied_internal = req_headers.get("x-kodera-internal-token", "")
        expected_internal = _configured_internal_token(environ)
        if (
            not isinstance(supplied_internal, str)
            or not (1 <= len(supplied_internal) <= 512)
            or not supplied_internal.isascii()
            or expected_internal is None
            or not hmac.compare_digest(
                supplied_internal.encode("ascii"), expected_internal.encode("ascii")
            )
        ):
            raise BillingUnauthenticatedError()
        return BillingPrincipal(
            lane="internal",
            identity_id="system:ee-internal",
            live_authority=True,
        )

    authorization = req_headers.get("authorization", "")
    if not isinstance(authorization, str) or not (
        1 <= len(authorization) <= MAX_BEARER_HEADER_BYTES
    ):
        raise BillingUnauthenticatedError()
    parts = authorization.split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1]:
        raise BillingUnauthenticatedError()
    raw_token = parts[1]

    from django.conf import settings

    from apps.identity.staff import StaffPrincipalError, resolve_staff_principal
    from apps.orgs.authority_selectors import (
        MemberAuthorityNotFoundError,
        MemberAuthorityUnavailableError,
        resolve_member_authority,
    )
    from core.api import lanes
    from services.identity.access_tokens import TokenVerificationError
    from services.identity.trusted_issuers import verify_configured_token

    try:
        verified, lane = verify_configured_token(raw_token, trusted=settings.KODERA_AUTH_TRUST)
        verified, lane = lanes.admit(verified, lane)
    except TokenVerificationError as exc:
        raise BillingUnauthenticatedError() from exc

    if lane == "staff":
        from apps.identity.models import Identity, StaffRole

        try:
            staff = resolve_staff_principal(verified, lane)
        except StaffPrincipalError as exc:
            raise BillingForbiddenError() from exc
        staff_user_id = (
            Identity.objects.filter(id=staff.identity_id).values_list("user_id", flat=True).first()
        )
        if staff_user_id is None:
            raise BillingForbiddenError()
        active_staff_roles = frozenset(
            str(role)
            for role in StaffRole.objects.filter(
                identity_id=staff.identity_id,
                revoked_at__isnull=True,
            ).values_list("role", flat=True)
        )
        if not active_staff_roles:
            raise BillingForbiddenError()
        return BillingPrincipal(
            lane="staff",
            identity_id=str(staff.identity_id),
            staff_roles=active_staff_roles,
            user_id=str(staff_user_id),
            issuer=staff.issuer,
            subject=verified.subject,
            live_authority=True,
        )

    if lane == "customer":
        try:
            facts = resolve_member_authority(verified=verified)
        except (MemberAuthorityNotFoundError, MemberAuthorityUnavailableError) as exc:
            raise BillingForbiddenError() from exc
        return BillingPrincipal(
            lane="customer",
            identity_id=str(facts.identity_id),
            org_roles={str(facts.organisation_id): str(facts.stored_role)},
            user_id=str(facts.user_id),
            issuer=facts.issuer,
            subject=facts.subject,
            live_authority=True,
        )

    raise BillingForbiddenError()


@dataclass(frozen=True, slots=True)
class BillingHttpResponse:
    status_code: int
    content_type: str
    body: bytes
    headers: Mapping[str, str] = field(default_factory=dict)

    def json(self) -> dict[str, Any]:
        return cast(dict[str, Any], json.loads(self.body.decode("utf-8")))


def _json_response(status_code: int, payload: Mapping[str, Any]) -> BillingHttpResponse:
    return BillingHttpResponse(
        status_code=status_code,
        content_type="application/json",
        body=json.dumps(payload).encode("utf-8"),
        headers={"Cache-Control": "no-store"},
    )


def _problem_response(
    status_code: int,
    slug: str,
    title: str,
    detail: str | None = None,
    *,
    extra_headers: Mapping[str, str] | None = None,
) -> BillingHttpResponse:
    payload: dict[str, Any] = {
        "type": f"https://kodera.io/problems/{slug}",
        "title": title,
        "status": status_code,
    }
    if detail is not None:
        payload["detail"] = detail
    hdrs: dict[str, str] = {"Cache-Control": "no-store"}
    if status_code == 401:
        hdrs["WWW-Authenticate"] = "Bearer"
    if extra_headers:
        hdrs.update(extra_headers)
    return BillingHttpResponse(
        status_code=status_code,
        content_type="application/problem+json",
        body=json.dumps(payload).encode("utf-8"),
        headers=hdrs,
    )


def _serialize_po(po: PurchaseOrder) -> dict[str, Any]:
    raw = asdict(po)
    raw.pop("countersigned_by_user_id", None)
    for key, val in list(raw.items()):
        if isinstance(val, datetime):
            raw[key] = val.astimezone(UTC).isoformat().replace("+00:00", "Z")
    return raw


def _parse_json_object(raw: bytes) -> dict[str, Any]:
    if len(raw) > MAX_BODY_BYTES:
        raise ValueError("body exceeds limit")
    parsed = json.loads(raw.decode("utf-8") if raw else "{}")
    if not isinstance(parsed, dict):
        raise ValueError("JSON object expected")
    return parsed


def _match_po_subroute(
    path: str,
) -> tuple[str, Literal["item", "transitions", "commitment-check"]] | None:
    if not path.startswith(_PO_PREFIX):
        return None
    remainder = path[len(_PO_PREFIX) :]
    if not remainder:
        return None
    parts = remainder.split("/")
    if len(parts) not in (1, 2):
        return None
    po_id = parts[0]
    if not 1 <= len(po_id) <= 128 or any(ch not in _PO_ID_CHARS for ch in po_id):
        return None
    if len(parts) == 1:
        return po_id, "item"
    sub = parts[1]
    if sub == "transitions":
        return po_id, "transitions"
    if sub == "commitment-check":
        return po_id, "commitment-check"
    return None


def _require_staff_capability(
    principal: BillingPrincipal, allowed_staff_roles: frozenset[str]
) -> None:
    if principal.lane == "internal":
        return
    if principal.lane == "staff" and principal.has_staff_role(allowed_staff_roles):
        return
    raise BillingForbiddenError()


def _require_operator_settlement(principal: BillingPrincipal) -> None:
    """Restrict financial invoice/payment settlement strictly to `staff_operator` or `internal`."""
    _require_staff_capability(principal, _STAFF_MUTATION_ROLES)


def _require_org_commercial(
    principal: BillingPrincipal,
    organisation_id: object,
    *,
    allowed_staff_roles: frozenset[str] = _STAFF_MUTATION_ROLES,
) -> None:
    if principal.lane == "internal":
        return
    if principal.lane == "staff":
        if not principal.has_staff_role(allowed_staff_roles):
            raise BillingForbiddenError()
        return
    if not isinstance(organisation_id, str) or not principal.has_org_role(
        organisation_id, _ORG_COMMERCIAL_ROLES
    ):
        raise BillingForbiddenError()


def _require_customer_signatory(principal: BillingPrincipal) -> None:
    """Restrict PO countersignature exclusively to an authenticated customer signatory."""
    if principal.lane != "customer":
        raise BillingForbiddenError()
    if principal.live_authority and not principal.user_id:
        raise BillingForbiddenError()


class EnterpriseBillingRouter:
    """Edition-gated, RBAC-enforced HTTP dispatcher for Enterprise commercial billing."""

    def __init__(
        self,
        *,
        warm_pool: WarmPoolController | None = None,
        purchase_orders: PurchaseOrderBook | None = None,
        backend: StorageBackend = "auto",
        authenticator: Authenticator | None = None,
    ) -> None:
        self.warm_pool = warm_pool or WarmPoolController(
            PoolWatermarks(min_ready=2, target_ready=4, max_total=16),
            backend=backend,
        )
        self.purchase_orders = purchase_orders or PurchaseOrderBook(backend=backend)
        self._authenticator: Authenticator = (
            authenticator if authenticator is not None else authenticate_bearer_header
        )

    def dispatch(
        self,
        method: str,
        path: str,
        *,
        body: bytes = b"",
        headers: Mapping[str, str] | None = None,
        environ: Mapping[str, str] | None = None,
    ) -> BillingHttpResponse:
        # 1. Strict runtime open-core edition gate: Community mode always sees 404.
        if not is_enterprise_edition(environ):
            return _problem_response(404, "not-found", "Not found")

        verb = method.upper()
        req_headers = {k.lower(): v for k, v in (headers or {}).items()}

        # 2. Mandatory Bearer or internal operator authentication before executing any EE route.
        try:
            if self._authenticator is authenticate_bearer_header:
                principal = authenticate_bearer_header(req_headers, environ=environ)
            else:
                principal = self._authenticator(req_headers)
        except BillingUnauthenticatedError:
            return _problem_response(401, "unauthenticated", "Authentication required")
        except BillingForbiddenError:
            return _problem_response(403, "forbidden", "Access refused")

        try:
            if path == "/api/v1/ee/billing/plans":
                if verb != "GET":
                    return _problem_response(405, "method-not-allowed", "Method not allowed")
                if principal.lane not in ("staff", "internal", "customer"):
                    raise BillingForbiddenError()
                if principal.lane == "staff" and not principal.has_staff_role(_STAFF_READ_ROLES):
                    raise BillingForbiddenError()
                verify_caller_authority(
                    _to_caller_authority(
                        principal, _ALL_ORG_MEMBER_ROLES, allowed_staff_roles=_STAFF_READ_ROLES
                    ),
                    target_organisation_id=next(iter(principal.org_roles), None),
                )
                return _json_response(200, commercial_schedule_summary())

            if path == "/api/v1/ee/billing/quotes":
                if verb != "POST":
                    return _problem_response(405, "method-not-allowed", "Method not allowed")
                data = _parse_json_object(body)
                target_org = data.get("organisation_id")
                _require_org_commercial(
                    principal, target_org, allowed_staff_roles=_STAFF_READ_ROLES
                )
                verify_caller_authority(
                    _to_caller_authority(
                        principal, _ORG_COMMERCIAL_ROLES, allowed_staff_roles=_STAFF_READ_ROLES
                    ),
                    target_organisation_id=target_org if isinstance(target_org, str) else None,
                )
                quote = quote_plan(
                    data.get("plan_code", "team"),
                    seats=data.get("seats"),  # type: ignore[arg-type]
                    billing_cycle=data.get("billing_cycle", "annual"),
                    discount_bps=data.get("discount_bps", 0),
                    vat_rate_bps=data.get("vat_rate_bps", 2000),
                    cogs_override_minor=data.get("cogs_override_minor"),
                    custom_net_excl_vat_minor=data.get("custom_net_excl_vat_minor"),
                )
                return _json_response(200, asdict(quote))

            if path == "/api/v1/ee/billing/warm-pool":
                if verb != "GET":
                    return _problem_response(405, "method-not-allowed", "Method not allowed")
                _require_staff_capability(principal, _STAFF_READ_ROLES)
                snap = self.warm_pool.sizing_snapshot(
                    authority=_to_caller_authority(
                        principal, frozenset(), allowed_staff_roles=_STAFF_READ_ROLES
                    )
                )
                return _json_response(200, asdict(snap))

            if path == "/api/v1/ee/billing/warm-pool/replenish":
                if verb != "POST":
                    return _problem_response(405, "method-not-allowed", "Method not allowed")
                _require_staff_capability(principal, _STAFF_MUTATION_ROLES)
                data = _parse_json_object(body) if body else {}
                created = self.warm_pool.replenish(
                    region=data.get("region"),
                    profile_ref=data.get("profile_ref"),
                    authority=_to_caller_authority(
                        principal, frozenset(), allowed_staff_roles=_STAFF_MUTATION_ROLES
                    ),
                )
                return _json_response(
                    200,
                    {"created_slots": [asdict(slot) for slot in created], "count": len(created)},
                )

            if path == "/api/v1/ee/billing/warm-pool/evict":
                if verb != "POST":
                    return _problem_response(405, "method-not-allowed", "Method not allowed")
                _require_staff_capability(principal, _STAFF_MUTATION_ROLES)
                data = _parse_json_object(body) if body else {}
                evicted = self.warm_pool.evict_unhealthy(
                    region=data.get("region"),
                    profile_ref=data.get("profile_ref"),
                    authority=_to_caller_authority(
                        principal, frozenset(), allowed_staff_roles=_STAFF_MUTATION_ROLES
                    ),
                )
                return _json_response(
                    200,
                    {"evicted_slots": [asdict(slot) for slot in evicted], "count": len(evicted)},
                )

            if path == "/api/v1/ee/billing/warm-pool/claim":
                if verb != "POST":
                    return _problem_response(405, "method-not-allowed", "Method not allowed")
                data = _parse_json_object(body)
                org_id = data.get("organisation_id", "")
                _require_org_commercial(
                    principal, org_id, allowed_staff_roles=_STAFF_MUTATION_ROLES
                )
                idem_key = req_headers.get("idempotency-key") or data.get("idempotency_key", "")
                claimed = self.warm_pool.claim_slot(
                    idempotency_key=idem_key,
                    organisation_id=org_id,
                    checkout_id=data.get("checkout_id", ""),
                    region=data.get("region"),
                    profile_ref=data.get("profile_ref"),
                    authority=_to_caller_authority(
                        principal, _ORG_COMMERCIAL_ROLES, allowed_staff_roles=_STAFF_MUTATION_ROLES
                    ),
                )
                return _json_response(
                    200 if claimed.replayed else 201,
                    {
                        "slot": asdict(claimed.slot),
                        "replayed": claimed.replayed,
                        "replenish_needed": claimed.replenish_needed,
                        "below_low_watermark": claimed.below_low_watermark,
                    },
                )

            if path == "/api/v1/ee/billing/purchase-orders":
                if verb != "POST":
                    return _problem_response(405, "method-not-allowed", "Method not allowed")
                data = _parse_json_object(body)
                org_id = data.get("organisation_id", "")
                _require_org_commercial(
                    principal, org_id, allowed_staff_roles=_STAFF_MUTATION_ROLES
                )
                now = datetime.now(UTC)
                validity_days = data.get("validity_days", 30)
                if type(validity_days) is not int or not 1 <= validity_days <= 365:
                    return _problem_response(
                        422,
                        "validation-error",
                        "Validation error",
                        "Purchase order validity_days must be between 1 and 365.",
                    )
                po = self.purchase_orders.create_draft(
                    organisation_id=org_id,
                    customer_po_reference=data.get("customer_po_reference", ""),
                    plan_code=data.get("plan_code", "sovereign"),
                    billing_months=data.get("billing_months", 12),
                    committed_seats=data.get("committed_seats"),  # type: ignore[arg-type]
                    committed_storage_gb=data.get("committed_storage_gb"),  # type: ignore[arg-type]
                    subtotal_excl_vat_minor=data.get("subtotal_excl_vat_minor"),  # type: ignore[arg-type]
                    vat_rate_bps=data.get("vat_rate_bps", 2000),
                    estimated_cogs_minor=data.get("estimated_cogs_minor"),
                    created_at=now,
                    expires_at=now + timedelta(days=validity_days),
                    authority=_to_caller_authority(
                        principal, _ORG_COMMERCIAL_ROLES, allowed_staff_roles=_STAFF_MUTATION_ROLES
                    ),
                    environ=environ,
                )
                return _json_response(201, _serialize_po(po))

            po_route = _match_po_subroute(path)
            if po_route is not None:
                po_id, subkind = po_route
                if subkind == "item":
                    if verb != "GET":
                        return _problem_response(405, "method-not-allowed", "Method not allowed")
                    if principal.lane == "staff" and not principal.has_staff_role(
                        _STAFF_READ_ROLES
                    ):
                        raise BillingForbiddenError()
                    po = self.purchase_orders.get(
                        po_id,
                        authority=_to_caller_authority(
                            principal, _ORG_COMMERCIAL_ROLES, allowed_staff_roles=_STAFF_READ_ROLES
                        ),
                        environ=environ,
                    )
                    return _json_response(200, _serialize_po(po))

                if subkind == "transitions":
                    if verb != "POST":
                        return _problem_response(405, "method-not-allowed", "Method not allowed")
                    data = _parse_json_object(body)
                    action = data.get("action")
                    if action == "issue":
                        if principal.lane == "staff":
                            _require_staff_capability(principal, _STAFF_MUTATION_ROLES)
                        po = self.purchase_orders.issue(
                            po_id,
                            authority=_to_caller_authority(
                                principal,
                                _ORG_COMMERCIAL_ROLES,
                                allowed_staff_roles=_STAFF_MUTATION_ROLES,
                            ),
                            environ=environ,
                        )
                    elif action == "countersign":
                        _require_customer_signatory(principal)
                        po = self.purchase_orders.countersign(
                            po_id,
                            signatory=data.get("signatory", ""),
                            authority=_to_caller_authority(
                                principal,
                                _ORG_SETTLEMENT_ROLES,
                                allowed_staff_roles=frozenset(),
                            ),
                            environ=environ,
                        )
                    elif action == "invoice":
                        _require_operator_settlement(principal)
                        po = self.purchase_orders.bind_invoice(
                            po_id,
                            invoice_ref=data.get("invoice_ref", ""),
                            actor_lane=principal.lane,
                            authority=_to_caller_authority(
                                principal, frozenset(), allowed_staff_roles=_STAFF_MUTATION_ROLES
                            ),
                            environ=environ,
                        )
                    elif action == "pay":
                        _require_operator_settlement(principal)
                        po = self.purchase_orders.mark_paid(
                            po_id,
                            invoice_ref=data.get("invoice_ref", ""),
                            payment_ref=data.get("payment_ref", ""),
                            amount_paid_minor=data.get("amount_paid_minor"),  # type: ignore[arg-type]
                            actor_lane=principal.lane,
                            authority=_to_caller_authority(
                                principal, frozenset(), allowed_staff_roles=_STAFF_MUTATION_ROLES
                            ),
                            environ=environ,
                        )
                    elif action == "expire":
                        if principal.lane == "staff":
                            _require_staff_capability(principal, _STAFF_MUTATION_ROLES)
                        po = self.purchase_orders.expire(
                            po_id,
                            authority=_to_caller_authority(
                                principal,
                                _ORG_COMMERCIAL_ROLES,
                                allowed_staff_roles=_STAFF_MUTATION_ROLES,
                            ),
                            environ=environ,
                        )
                    else:
                        if principal.lane == "staff":
                            _require_staff_capability(principal, _STAFF_MUTATION_ROLES)
                        existing_po = self.purchase_orders.get(
                            po_id,
                            authority=_to_caller_authority(
                                principal,
                                _ORG_COMMERCIAL_ROLES,
                                allowed_staff_roles=_STAFF_MUTATION_ROLES,
                            ),
                            environ=environ,
                        )
                        _require_org_commercial(
                            principal,
                            existing_po.organisation_id,
                            allowed_staff_roles=_STAFF_MUTATION_ROLES,
                        )
                        return _problem_response(
                            422,
                            "validation-error",
                            "Validation error",
                            "Unsupported purchase order transition action.",
                        )
                    return _json_response(200, _serialize_po(po))

                if subkind == "commitment-check":
                    if verb != "POST":
                        return _problem_response(405, "method-not-allowed", "Method not allowed")
                    if principal.lane == "staff" and not principal.has_staff_role(
                        _STAFF_READ_ROLES
                    ):
                        raise BillingForbiddenError()
                    data = _parse_json_object(body)
                    evaluation = self.purchase_orders.evaluate_commitment(
                        po_id,
                        active_seats=data.get("active_seats"),  # type: ignore[arg-type]
                        used_storage_gb=data.get("used_storage_gb"),  # type: ignore[arg-type]
                        enforce_hard_cap=bool(data.get("enforce_hard_cap", True)),
                        authority=_to_caller_authority(
                            principal, _ORG_COMMERCIAL_ROLES, allowed_staff_roles=_STAFF_READ_ROLES
                        ),
                        environ=environ,
                    )
                    return _json_response(200, asdict(evaluation))

            return _problem_response(404, "not-found", "Not found")
        except (
            BillingForbiddenError,
            BillingAuthorityForbiddenError,
            PurchaseOrderForbiddenError,
        ):
            return _problem_response(403, "forbidden", "Access refused")
        except (
            MarginFloorViolationError,
            PricingValidationError,
            PurchaseOrderValidationError,
            WarmPoolValidationError,
        ) as exc:
            detail = _VALIDATION_MESSAGES.get(
                exc.code, "Commercial billing input failed validation."
            )
            return _problem_response(422, "validation-error", "Validation error", detail)
        except (ValueError, UnicodeDecodeError):
            return _problem_response(400, "malformed-request", "Malformed request")
        except TypeError:
            return _problem_response(
                422,
                "validation-error",
                "Validation error",
                "A field has an invalid JSON value type.",
            )
        except PurchaseOrderNotFoundError:
            return _problem_response(404, "not-found", "Not found")
        except (
            InvalidPurchaseOrderTransitionError,
            CommitmentExceededError,
            WarmPoolIdempotencyConflictError,
            WarmPoolTransitionError,
            BillingAuthorityConflictError,
        ) as exc:
            detail = _CONFLICT_MESSAGES.get(
                exc.code,
                "Requested billing state transition conflicts with current state.",
            )
            return _problem_response(409, "conflict", "Conflict", detail)
        except WarmPoolExhaustedError as exc:
            detail = _UNAVAILABLE_MESSAGES.get(
                exc.code,
                "No ready warm-pool slot is currently available for checkout claim.",
            )
            return _problem_response(503, "service-unavailable", "Service unavailable", detail)
