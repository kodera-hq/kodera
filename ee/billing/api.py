# SPDX-License-Identifier: LicenseRef-Kodera-EE
"""HTTP runtime router for Enterprise commercial billing (`ee/billing/api.py`).

All routes are strictly gated behind ``KODERA_EDITION=enterprise`` at request time and
return HTTP ``404`` (`application/problem+json`) whenever ``KODERA_EDITION`` is ``community``
or anything other than ``enterprise``.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, cast

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
    PurchaseOrderNotFoundError,
    PurchaseOrderValidationError,
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
PO_ITEM_RE = re.compile(r"^/api/v1/ee/billing/purchase-orders/(?P<po_id>[A-Za-z0-9_-]+)\Z")
PO_TRANSITION_RE = re.compile(
    r"^/api/v1/ee/billing/purchase-orders/(?P<po_id>[A-Za-z0-9_-]+)/transitions\Z"
)
PO_COMMITMENT_RE = re.compile(
    r"^/api/v1/ee/billing/purchase-orders/(?P<po_id>[A-Za-z0-9_-]+)/commitment-check\Z"
)


@dataclass(frozen=True, slots=True)
class BillingHttpResponse:
    status_code: int
    content_type: str
    body: bytes

    def json(self) -> dict[str, Any]:
        return cast(dict[str, Any], json.loads(self.body.decode("utf-8")))


def _json_response(status_code: int, payload: Mapping[str, Any]) -> BillingHttpResponse:
    return BillingHttpResponse(
        status_code=status_code,
        content_type="application/json",
        body=json.dumps(payload).encode("utf-8"),
    )


def _problem_response(
    status_code: int, slug: str, title: str, detail: str | None = None
) -> BillingHttpResponse:
    payload: dict[str, Any] = {
        "type": f"https://kodera.io/problems/{slug}",
        "title": title,
        "status": status_code,
    }
    if detail is not None:
        payload["detail"] = detail
    return BillingHttpResponse(
        status_code=status_code,
        content_type="application/problem+json",
        body=json.dumps(payload).encode("utf-8"),
    )


def _serialize_po(po: PurchaseOrder) -> dict[str, Any]:
    raw = asdict(po)
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


class EnterpriseBillingRouter:
    """Edition-gated HTTP dispatcher for commercial plans, warm-pool Autopilot, and POs."""

    def __init__(
        self,
        *,
        warm_pool: WarmPoolController | None = None,
        purchase_orders: PurchaseOrderBook | None = None,
    ) -> None:
        self.warm_pool = warm_pool or WarmPoolController(
            PoolWatermarks(min_ready=2, target_ready=4, max_total=16)
        )
        self.purchase_orders = purchase_orders or PurchaseOrderBook()

    def dispatch(
        self,
        method: str,
        path: str,
        *,
        body: bytes = b"",
        headers: Mapping[str, str] | None = None,
        environ: Mapping[str, str] | None = None,
    ) -> BillingHttpResponse:
        # Strict runtime open-core edition gate: Community mode always sees 404.
        if not is_enterprise_edition(environ):
            return _problem_response(404, "not-found", "Not found")

        verb = method.upper()
        req_headers = {k.lower(): v for k, v in (headers or {}).items()}

        try:
            if path == "/api/v1/ee/billing/plans":
                if verb != "GET":
                    return _problem_response(405, "method-not-allowed", "Method not allowed")
                return _json_response(200, commercial_schedule_summary())

            if path == "/api/v1/ee/billing/quotes":
                if verb != "POST":
                    return _problem_response(405, "method-not-allowed", "Method not allowed")
                data = _parse_json_object(body)
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
                snap = self.warm_pool.sizing_snapshot()
                return _json_response(200, asdict(snap))

            if path == "/api/v1/ee/billing/warm-pool/replenish":
                if verb != "POST":
                    return _problem_response(405, "method-not-allowed", "Method not allowed")
                data = _parse_json_object(body) if body else {}
                created = self.warm_pool.replenish(
                    region=data.get("region"),
                    profile_ref=data.get("profile_ref"),
                )
                return _json_response(
                    200,
                    {"created_slots": [asdict(slot) for slot in created], "count": len(created)},
                )

            if path == "/api/v1/ee/billing/warm-pool/claim":
                if verb != "POST":
                    return _problem_response(405, "method-not-allowed", "Method not allowed")
                data = _parse_json_object(body)
                idem_key = req_headers.get("idempotency-key") or data.get("idempotency_key", "")
                claimed = self.warm_pool.claim_slot(
                    idempotency_key=idem_key,
                    organisation_id=data.get("organisation_id", ""),
                    checkout_id=data.get("checkout_id", ""),
                    region=data.get("region"),
                    profile_ref=data.get("profile_ref"),
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
                now = datetime.now(UTC)
                validity_days = data.get("validity_days", 30)
                if type(validity_days) is not int or not 1 <= validity_days <= 365:
                    return _problem_response(
                        422, "validation-error", "Validation error", "validity_days must be 1..365"
                    )
                po = self.purchase_orders.create_draft(
                    organisation_id=data.get("organisation_id", ""),
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
                    environ=environ,
                )
                return _json_response(201, _serialize_po(po))

            if match := PO_ITEM_RE.fullmatch(path):
                if verb != "GET":
                    return _problem_response(405, "method-not-allowed", "Method not allowed")
                po = self.purchase_orders.get(match.group("po_id"), environ=environ)
                return _json_response(200, _serialize_po(po))

            if match := PO_TRANSITION_RE.fullmatch(path):
                if verb != "POST":
                    return _problem_response(405, "method-not-allowed", "Method not allowed")
                data = _parse_json_object(body)
                po_id = match.group("po_id")
                action = data.get("action")
                if action == "issue":
                    po = self.purchase_orders.issue(po_id, environ=environ)
                elif action == "countersign":
                    po = self.purchase_orders.countersign(
                        po_id, signatory=data.get("signatory", ""), environ=environ
                    )
                elif action == "invoice":
                    po = self.purchase_orders.bind_invoice(
                        po_id, invoice_ref=data.get("invoice_ref", ""), environ=environ
                    )
                elif action == "pay":
                    po = self.purchase_orders.mark_paid(
                        po_id,
                        invoice_ref=data.get("invoice_ref", ""),
                        payment_ref=data.get("payment_ref", ""),
                        amount_paid_minor=data.get("amount_paid_minor"),  # type: ignore[arg-type]
                        environ=environ,
                    )
                elif action == "expire":
                    po = self.purchase_orders.expire(po_id, environ=environ)
                else:
                    return _problem_response(
                        422, "validation-error", "Validation error", "unknown transition action"
                    )
                return _json_response(200, _serialize_po(po))

            if match := PO_COMMITMENT_RE.fullmatch(path):
                if verb != "POST":
                    return _problem_response(405, "method-not-allowed", "Method not allowed")
                data = _parse_json_object(body)
                evaluation = self.purchase_orders.evaluate_commitment(
                    match.group("po_id"),
                    active_seats=data.get("active_seats"),  # type: ignore[arg-type]
                    used_storage_gb=data.get("used_storage_gb"),  # type: ignore[arg-type]
                    enforce_hard_cap=bool(data.get("enforce_hard_cap", True)),
                    environ=environ,
                )
                return _json_response(200, asdict(evaluation))

            return _problem_response(404, "not-found", "Not found")
        except (ValueError, UnicodeDecodeError) as exc:
            if isinstance(
                exc,
                (
                    MarginFloorViolationError,
                    PricingValidationError,
                    PurchaseOrderValidationError,
                    WarmPoolValidationError,
                ),
            ):
                return _problem_response(422, "validation-error", "Validation error", str(exc))
            return _problem_response(400, "malformed-request", "Malformed request")
        except TypeError as exc:
            return _problem_response(422, "validation-error", "Validation error", str(exc))
        except PurchaseOrderNotFoundError:
            return _problem_response(404, "not-found", "Not found")
        except (
            InvalidPurchaseOrderTransitionError,
            CommitmentExceededError,
            WarmPoolIdempotencyConflictError,
            WarmPoolTransitionError,
        ) as exc:
            return _problem_response(409, "conflict", "Conflict", str(exc))
        except WarmPoolExhaustedError as exc:
            return _problem_response(503, "service-unavailable", "Service unavailable", str(exc))
