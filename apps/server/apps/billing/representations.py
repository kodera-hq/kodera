"""The contract's shapes of the billing rows: `Plan`, `Pack`, `CapacityTier`, `Price`, `Order`,
`Subscription`, `Invoice` and `PaymentLink` of contracts/core-api.openapi.yaml.

Plain JSON values, built from the stored row and nothing else: a snapshot is rendered as it was
written, never recomputed from the catalogue. Money is `{amount_minor, currency}`; timestamps are
RFC 3339 in UTC with `Z`. A field the contract types as non-null is left out rather than sent null.
"""

from datetime import UTC, datetime
from typing import Any

from .models import (
    CapacityTier,
    CreditNote,
    Invoice,
    Order,
    Pack,
    PaymentLink,
    Plan,
    Price,
    Subscription,
)

JSON = dict[str, Any]


def instant(value: datetime | None) -> str | None:
    return None if value is None else value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def money(amount_minor: int, currency: str) -> JSON:
    return {"amount_minor": amount_minor, "currency": currency}


def plan(row: Plan, packs: list[str]) -> JSON:
    return {
        "code": row.code,
        "version": row.version,
        "name": row.name,
        "description": row.description,
        "state": row.state,
        "packs": packs,
        "support_tier": row.support_tier,
        "published_at": instant(row.published_at),
        "retired_at": instant(row.retired_at),
    }


def pack(row: Pack, tiers: list[str]) -> JSON:
    return {
        "code": row.code,
        "name": row.name,
        "description": row.description,
        "apps": list(row.apps),
        "profile_ref": row.profile_ref,
        "capacity_tier_codes": tiers,
        "available": row.available,
    }


def capacity_tier(row: CapacityTier) -> JSON:
    return {
        "code": row.code,
        "name": row.name,
        "description": row.description,
        "seats_included": row.seats_included,
        "concurrent_participants_included": row.concurrent_participants_included,
        "storage_included_bytes": row.storage_included_bytes,
        # `vm_shape` is staff-facing (contract `CapacityTier`): the public catalogue leaves it out.
        "media_ip_dedicated": row.media_ip_dedicated,
        "available": row.available,
    }


def price(row: Price) -> JSON:
    return {
        "id": str(row.id),
        "plan_code": row.plan.code,
        "plan_version": row.plan.version,
        "pack_code": row.pack.code,
        "capacity_tier_code": row.capacity_tier.code,
        "billing_period": row.billing_period,
        "amount_excl_vat": money(row.amount_minor, row.currency),
        "setup_fee_excl_vat": (
            None if row.setup_fee_minor is None else money(row.setup_fee_minor, row.currency)
        ),
        "valid_from": instant(row.valid_from),
        "valid_to": instant(row.valid_to),
    }


def price_snapshot(row: Order | Subscription) -> JSON:
    return {
        "price_id": str(row.price_id),
        "plan_code": row.plan_code,
        "plan_version": row.plan_version,
        "pack_code": row.pack_code,
        "capacity_tier_code": row.capacity_tier_code,
        "billing_period": row.billing_period,
        "unit_amount_excl_vat": money(row.unit_amount_minor, row.currency),
        "quantity": row.quantity,
        "vat_regime": row.vat_regime,
        "vat_rate_bp": row.vat_rate_bp,
        "total_excl_vat": money(row.total_excl_vat_minor, row.currency),
        "vat_amount": money(row.vat_amount_minor, row.currency),
        "total_incl_vat": money(row.total_incl_vat_minor, row.currency),
        "captured_at": instant(row.captured_at),
    }


def _optional(body: JSON, **values: object) -> JSON:
    body.update({key: value for key, value in values.items() if value is not None})
    return body


def order(row: Order, *, subscription_id: object, invoice_id: object) -> JSON:
    body: JSON = {
        "id": str(row.id),
        "organisation_id": str(row.organisation_id),
        "state": row.state,
        "pack_code": row.pack_code,
        "capacity_tier_code": row.capacity_tier_code,
        "apps": list(row.apps),
        "billing_period": row.billing_period,
        "price_snapshot": price_snapshot(row),
        "subscription_id": None if subscription_id is None else str(subscription_id),
        "invoice_id": None if invoice_id is None else str(invoice_id),
        "tenant_id": None if row.tenant_id is None else str(row.tenant_id),
        "purchase_order_ref": row.purchase_order_ref,
        "placed_by": str(row.placed_by),
        "created_at": instant(row.created_at),
        "updated_at": instant(row.updated_at),
    }
    return _optional(body, dpa_id=None if row.dpa_id is None else str(row.dpa_id))


def subscription(row: Subscription) -> JSON:
    return {
        "id": str(row.id),
        "organisation_id": str(row.organisation_id),
        "tenant_id": None if row.tenant_id is None else str(row.tenant_id),
        "order_id": str(row.order_id),
        "state": row.state,
        "plan_code": row.plan_code,
        "plan_version": row.plan_version,
        "pack_code": row.pack_code,
        "capacity_tier_code": row.capacity_tier_code,
        "billing_period": row.billing_period,
        "price_snapshot": price_snapshot(row),
        "current_period_start": instant(row.current_period_start),
        "current_period_end": instant(row.current_period_end),
        "cancel_at_period_end": row.cancel_at_period_end,
        "cancelled_at": instant(row.cancelled_at),
        "next_invoice_at": (
            None
            if row.state == "cancelled" or row.cancel_at_period_end
            else instant(row.current_period_end)
        ),
        "price_change_notice_days": row.price_change_notice_days,
        "created_at": instant(row.created_at),
        "updated_at": instant(row.updated_at),
    }


def invoice(row: Invoice, *, staff: bool = False) -> JSON:
    """`external_ref` is staff-facing: a tenant caller does not receive it."""
    from .artifacts import metadata

    currency = row.currency
    body: JSON = {
        "id": str(row.id),
        "organisation_id": str(row.organisation_id),
        "subscription_id": None if row.subscription_id is None else str(row.subscription_id),
        "order_id": None if row.order_id is None else str(row.order_id),
        "number": row.number,
        "state": row.state,
        "currency": currency,
        "vat_regime": row.vat_regime,
        "lines": [
            {
                "description": line.description,
                "quantity": line.quantity,
                "unit_amount_excl_vat": money(line.unit_amount_minor, currency),
                "total_excl_vat": money(line.total_excl_vat_minor, currency),
                "vat_rate_bp": line.vat_rate_bp,
                "period_start": instant(line.period_start),
                "period_end": instant(line.period_end),
            }
            for line in row.lines.order_by("position")
        ],
        "total_excl_vat": money(row.total_excl_vat_minor, currency),
        "vat_amount": money(row.vat_amount_minor, currency),
        "total_incl_vat": money(row.total_incl_vat_minor, currency),
        "amount_due": money(
            0
            if row.state in ("void", "credited")
            else max(row.total_incl_vat_minor - row.amount_paid_minor, 0),
            currency,
        ),
        "issued_at": instant(row.issued_at),
        "due_at": instant(row.due_at),
        "paid_at": instant(row.paid_at),
        "pdf_available": row.pdf_ref is not None,
        "credit_note_id": next((str(note.id) for note in row.credit_notes.all()), None),
        "created_at": instant(row.created_at),
        "updated_at": instant(row.updated_at),
    }
    if staff:
        body["external_ref"] = row.external_ref
    body.update(metadata(row))
    return body


def credit_note(row: CreditNote) -> JSON:
    """The contract's `CreditNote`: what it credits, with the lines of the invoice it credits."""
    from .artifacts import metadata

    currency = row.currency
    return {
        **metadata(row),
        "id": str(row.id),
        "organisation_id": str(row.organisation_id),
        "invoice_id": str(row.invoice_id),
        "invoice_number": row.invoice.number,
        "number": row.number,
        "issued_at": instant(row.issued_at),
        "reason": row.reason,
        "currency": currency,
        "vat_regime": row.vat_regime,
        "lines": [
            {
                "description": line.description,
                "quantity": line.quantity,
                "unit_amount_excl_vat": money(line.unit_amount_minor, currency),
                "total_excl_vat": money(line.total_excl_vat_minor, currency),
                "vat_rate_bp": line.vat_rate_bp,
                "period_start": instant(line.period_start),
                "period_end": instant(line.period_end),
            }
            # Prefetched in position order by the list; read in order otherwise.
            for line in sorted(row.lines.all(), key=lambda line: line.position)
        ],
        "total_excl_vat": money(row.total_excl_vat_minor, currency),
        "vat_amount": money(row.vat_amount_minor, currency),
        "total_incl_vat": money(row.total_incl_vat_minor, currency),
    }


def payment_link(row: PaymentLink) -> JSON:
    return {
        "id": str(row.id),
        "invoice_id": str(row.invoice_id),
        "url": row.url,
        "state": row.state,
        "amount": money(row.amount_minor, row.currency),
        "expires_at": instant(row.expires_at),
        "used_at": instant(row.used_at),
        "created_at": instant(row.created_at),
    }
