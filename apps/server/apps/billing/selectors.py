"""Billing reads, as the contract's pages and resources.

The public catalogue serves published plans only, and the packs, tiers and prices they offer. An
organisation's rows are read through apps/billing/access.py, which scopes every query to the
caller's organisation: an identifier from another organisation reads as absent. Pages are keyset
ordered with the row id as the tiebreaker (docs/api/CONVENTIONS.md §12).
"""

from collections.abc import Iterable
from datetime import datetime
from typing import Any
from uuid import UUID

from django.db.models import Exists, F, OuterRef, Prefetch, Q, QuerySet
from django.utils import timezone

from . import representations as shape
from .models import (
    CapacityTier,
    CreditNote,
    CreditNoteLine,
    Invoice,
    Order,
    Pack,
    PaymentLink,
    Plan,
    Price,
    Subscription,
)
from .pagination import InvalidListQueryError, ListQuery, encode_cursor

JSON = dict[str, Any]


def _page(
    rows: list[Any],
    *,
    query: ListQuery,
    operation: str,
    scope: str,
    position: Any,
    render: Any,
) -> JSON:
    more = len(rows) > query.limit
    rows = rows[: query.limit]
    cursor = None
    if more:
        cursor = encode_cursor(
            operation=operation, scope=scope, filters=query.filters, after=position(rows[-1])
        )
    return {"data": [render(row) for row in rows], "next_cursor": cursor, "has_more": more}


def _uuid(value: str) -> UUID:
    try:
        return UUID(value)
    except ValueError:
        raise InvalidListQueryError() from None


def _instant(value: str) -> datetime:
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        raise InvalidListQueryError() from None


def _by_id(rows: QuerySet[Any], query: ListQuery) -> list[Any]:
    if query.after is not None:
        (after,) = query.after
        rows = rows.filter(id__gt=_uuid(after))
    return list(rows.order_by("id")[: query.limit + 1])


def _newest_first(rows: QuerySet[Any], query: ListQuery, field: str) -> list[Any]:
    if query.after is not None:
        moment, after = query.after
        at, key = _instant(moment), _uuid(after)
        rows = rows.filter(Q(**{f"{field}__lt": at}) | Q(**{field: at, "id__lt": key}))
    return list(rows.order_by(f"-{field}", "-id")[: query.limit + 1])


def _newest_position(field: str) -> Any:
    return lambda row: (shape.instant(getattr(row, field)), str(row.id))


# --- the public catalogue ---------------------------------------------------------------------


def _offered_prices() -> QuerySet[Price]:
    """The prices an order would be placed at now: under a published plan, for a pack and tier on
    sale, started and not ended, and for each plan, pack, tier and period only the one with the
    latest start, the one `services.current_price` resolves (an older price is superseded from the
    newer one's start)."""
    now = timezone.now()
    current = (
        Price.objects.filter(plan__state="published", valid_from__lte=now)
        .filter(Q(valid_to__isnull=True) | Q(valid_to__gt=now))
        # A pack or tier not on sale is refused by `current_price`: none of its prices is offered.
        .filter(pack__available=True, capacity_tier__available=True)
    )
    newer = current.filter(
        plan=OuterRef("plan"),
        pack=OuterRef("pack"),
        capacity_tier=OuterRef("capacity_tier"),
        billing_period=OuterRef("billing_period"),
        valid_from__gt=OuterRef("valid_from"),
    )
    return current.exclude(Exists(newer))


def _codes(values: Iterable[str]) -> list[str]:
    return sorted(set(values))


def list_plans(query: ListQuery) -> JSON:
    state = query.filters.get("state", "published")
    # The public catalogue shows published plans only: a draft or retired one is staff's.
    rows = Plan.objects.filter(state="published") if state == "published" else Plan.objects.none()
    page = _by_id(rows, query)
    packs: dict[UUID, list[str]] = {
        row.id: _codes(_offered_prices().filter(plan=row).values_list("pack__code", flat=True))
        for row in page
    }
    return _page(
        page,
        query=query,
        operation="listPlans",
        scope="",
        position=lambda row: (str(row.id),),
        render=lambda row: shape.plan(row, packs[row.id]),
    )


def list_packs(query: ListQuery) -> JSON:
    page = _by_id(Pack.objects.all(), query)
    return _page(
        page,
        query=query,
        operation="listPacks",
        scope="",
        position=lambda row: (str(row.id),),
        render=lambda row: shape.pack(
            row,
            _codes(
                _offered_prices().filter(pack=row).values_list("capacity_tier__code", flat=True)
            ),
        ),
    )


def list_capacity_tiers(query: ListQuery) -> JSON:
    rows = CapacityTier.objects.all()
    if "pack_code" in query.filters:
        rows = rows.filter(
            id__in=_offered_prices()
            .filter(pack__code=query.filters["pack_code"])
            .values("capacity_tier_id")
        )
    return _page(
        _by_id(rows, query),
        query=query,
        operation="listCapacityTiers",
        scope="",
        position=lambda row: (str(row.id),),
        render=shape.capacity_tier,
    )


def list_prices(query: ListQuery) -> JSON:
    rows = _offered_prices().select_related("plan", "pack", "capacity_tier")
    if "pack_code" in query.filters:
        rows = rows.filter(pack__code=query.filters["pack_code"])
    if "capacity_tier_code" in query.filters:
        rows = rows.filter(capacity_tier__code=query.filters["capacity_tier_code"])
    if "billing_period" in query.filters:
        rows = rows.filter(billing_period=query.filters["billing_period"])
    return _page(
        _by_id(rows, query),
        query=query,
        operation="listPrices",
        scope="",
        position=lambda row: (str(row.id),),
        render=shape.price,
    )


# --- an organisation's rows -------------------------------------------------------------------


def _order(row: Order) -> JSON:
    subscription = Subscription.objects.filter(order=row).values_list("id", flat=True).first()
    invoice = (
        Invoice.objects.filter(order=row)
        .order_by("created_at", "id")
        .values_list("id", flat=True)
        .first()
    )
    return shape.order(row, subscription_id=subscription, invoice_id=invoice)


def list_orders(*, organisation_id: UUID, query: ListQuery) -> JSON:
    rows = Order.objects.filter(organisation_id=organisation_id)
    return _page(
        _newest_first(rows, query, "created_at"),
        query=query,
        operation="listOrders",
        scope=str(organisation_id),
        position=_newest_position("created_at"),
        render=_order,
    )


def get_order(*, organisation_id: UUID, order_id: UUID) -> JSON | None:
    row = Order.objects.filter(organisation_id=organisation_id, id=order_id).first()
    return None if row is None else _order(row)


def list_subscriptions(*, organisation_id: UUID, query: ListQuery) -> JSON:
    rows = Subscription.objects.filter(organisation_id=organisation_id)
    if "state" in query.filters:
        rows = rows.filter(state=query.filters["state"])
    return _page(
        _newest_first(rows, query, "created_at"),
        query=query,
        operation="listSubscriptions",
        scope=str(organisation_id),
        position=_newest_position("created_at"),
        render=shape.subscription,
    )


def get_subscription(*, organisation_id: UUID, subscription_id: UUID) -> JSON | None:
    row = Subscription.objects.filter(organisation_id=organisation_id, id=subscription_id).first()
    return None if row is None else shape.subscription(row)


def _issued(organisation_id: UUID) -> QuerySet[Invoice]:
    # A draft is Core's working copy, never a document the customer has received.
    return (
        Invoice.objects.filter(organisation_id=organisation_id)
        .exclude(state="draft")
        .prefetch_related("credit_notes")
    )


def list_invoices(*, organisation_id: UUID, query: ListQuery) -> JSON:
    rows = _issued(organisation_id)
    if "state" in query.filters:
        rows = rows.filter(state=query.filters["state"])
    return _page(
        _newest_first(rows, query, "issued_at"),
        query=query,
        operation="listInvoices",
        scope=str(organisation_id),
        position=_newest_position("issued_at"),
        render=shape.invoice,
    )


def get_invoice(*, organisation_id: UUID, invoice_id: UUID) -> JSON | None:
    row = _issued(organisation_id).filter(id=invoice_id).first()
    return None if row is None else shape.invoice(row)


def list_credit_notes(*, organisation_id: UUID, query: ListQuery) -> JSON:
    rows = (
        CreditNote.objects.filter(organisation_id=organisation_id)
        .select_related("invoice")
        .prefetch_related(Prefetch("lines", queryset=CreditNoteLine.objects.order_by("position")))
    )
    return _page(
        _newest_first(rows, query, "issued_at"),
        query=query,
        operation="listCreditNotes",
        scope=str(organisation_id),
        position=_newest_position("issued_at"),
        render=shape.credit_note,
    )


def get_credit_note(*, organisation_id: UUID, credit_note_id: UUID) -> JSON | None:
    row = (
        CreditNote.objects.filter(organisation_id=organisation_id, id=credit_note_id)
        .select_related("invoice")
        .first()
    )
    return None if row is None else shape.credit_note(row)


def credit_note_owner(credit_note_id: UUID) -> UUID | None:
    owner: UUID | None = (
        CreditNote.objects.filter(id=credit_note_id)
        .values_list("organisation_id", flat=True)
        .first()
    )
    return owner


def get_payment_link(*, organisation_id: UUID, invoice_id: UUID) -> JSON | None:
    """The invoice's active, unexpired link while the invoice is owed, or None: the `404`."""
    row = PaymentLink.objects.filter(
        organisation_id=organisation_id,
        invoice_id=invoice_id,
        invoice__state__in=("issued", "overdue"),
        invoice__amount_paid_minor__lt=F("invoice__total_incl_vat_minor"),
        state="active",
        expires_at__gt=timezone.now(),
    ).first()
    return None if row is None else shape.payment_link(row)


def order_owner(order_id: UUID) -> UUID | None:
    owner: UUID | None = (
        Order.objects.filter(id=order_id).values_list("organisation_id", flat=True).first()
    )
    return owner


def subscription_owner(subscription_id: UUID) -> UUID | None:
    owner: UUID | None = (
        Subscription.objects.filter(id=subscription_id)
        .values_list("organisation_id", flat=True)
        .first()
    )
    return owner


class InvoicePdfNotRenderedError(Exception):
    """The invoice has no rendered PDF (`pdf_available` is false): getInvoiceDownloadLink's `409`."""


def invoice_download_link(*, organisation_id: UUID, invoice_id: UUID) -> JSON | None:
    """The short-lived link to the invoice's PDF, or None when the organisation has no such invoice.

    Core renders no invoice PDF yet, and no Object Storage signer exists to sign a link to one, so
    every invoice is `pdf_available: false` and answers `InvoicePdfNotRenderedError`. A `pdf_ref`
    set by other means has nothing to sign it: that fails loudly (`500`), never as a link to a
    document Core cannot vouch for.
    """
    found = (
        _any_invoice()
        .filter(id=invoice_id, organisation_id=organisation_id)
        .values_list("pdf_ref")
        .first()
    )
    if found is None:
        return None
    if found[0] is None:
        raise InvoicePdfNotRenderedError()
    raise RuntimeError("an invoice PDF is stored but no document signer is configured")


def invoice_owner(invoice_id: UUID) -> UUID | None:
    owner: UUID | None = (
        _any_invoice().filter(id=invoice_id).values_list("organisation_id", flat=True).first()
    )
    return owner


def _any_invoice() -> QuerySet[Invoice]:
    return Invoice.objects.exclude(state="draft")


def pack_is_available(*, code: str) -> bool:
    """Whether a pack of that code is on sale: the DPA is generated for a pack the order can name."""
    return Pack.objects.filter(code=code, available=True).exists()


def has_committed_order(*, organisation_id: UUID) -> bool:
    """Whether the organisation has an order that is not cancelled and whose DPA is accepted: the
    order carries the customer's accepted CGV and DPA, what a workspace is created against."""
    return (
        Order.objects.filter(organisation_id=organisation_id, dpa__state="accepted")
        .exclude(state="cancelled")
        .exists()
    )


def tenant_has_order(*, tenant_id: UUID) -> bool:
    """Whether any order, in any state, names the tenant: the operator override moves only a tenant
    no order ever named (QUICK_WORKSPACE.md §5), since an order's tenant moves with its order."""
    return Order.objects.filter(tenant_id=tenant_id).exists()


# --- the shell's status summary -----------------------------------------------------------------

# The subscription states that put an organisation on the ladder, most severe first. Any other
# state not cancelled (`pending`, `active`) is `current`.
DUNNING = ("suspended", "past_due")


def _dunning(organisation_id: UUID) -> tuple[str, UUID | None, datetime | None]:
    """The organisation's dunning state, the most severe over its subscriptions not cancelled, so
    a newer subscription in good standing never hides an older one on the ladder; and the id and
    due date of its oldest overdue invoice, by due date as the ladder counts it. The two are read
    independently: with several subscriptions, the invoice named need not be the one whose
    subscription sets the state."""
    states = set(
        Subscription.objects.filter(organisation_id=organisation_id)
        .exclude(state="cancelled")
        .values_list("state", flat=True)
    )
    state = next((step for step in DUNNING if step in states), "current")
    overdue = (
        Invoice.objects.filter(organisation_id=organisation_id, state="overdue")
        .order_by("due_at", "issued_at", "id")
        .values_list("id", "due_at")
        .first()
    )
    return (state, None, None) if overdue is None else (state, overdue[0], overdue[1])


def dunning(organisation_id: UUID) -> tuple[str, str | None]:
    """The organisation's dunning state and its oldest overdue invoice's id: the shell's summary."""
    state, overdue, _ = _dunning(organisation_id)
    return state, None if overdue is None else str(overdue)


def dunning_view(organisation_id: UUID) -> JSON:
    """getDunning: the state and the oldest overdue invoice of `dunning`, and how many whole days
    that invoice is past its due date. An organisation with no subscription and no invoice is
    `current`. The ladder's dated steps, the amount due and a dispute hold are not modelled yet,
    so `steps` is empty and the three are null, which the contract allows. No scheduler moves an
    issued invoice to `overdue` yet either, so `current` means nothing is recorded as overdue, not
    that nothing is late."""
    state, overdue, due_at = _dunning(organisation_id)
    return {
        "state": state,
        "oldest_overdue_invoice_id": None if overdue is None else str(overdue),
        "days_overdue": None if due_at is None else max(0, (timezone.now() - due_at).days),
        "amount_due": None,
        "hold_until": None,
        "steps": [],
    }
