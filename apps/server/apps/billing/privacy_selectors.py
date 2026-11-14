"""Scoped accounting projections for private export workers; no ledger mutations."""

from collections.abc import Iterator
from typing import Any
from uuid import UUID

from .models import CreditNote, Invoice, Order

ORDER_FIELDS = (
    "id",
    "organisation_id",
    "state",
    "placed_by",
    "created_at",
    "billing_contact_email",
    "billing_contact_name",
    "purchase_order_ref",
)
INVOICE_FIELDS = (
    "id",
    "organisation_id",
    "number",
    "state",
    "currency",
    "issued_at",
    "due_at",
    "paid_at",
    "total_excl_vat_minor",
    "vat_amount_minor",
    "total_incl_vat_minor",
    "amount_paid_minor",
)
CREDIT_FIELDS = (
    "id",
    "organisation_id",
    "invoice_id",
    "number",
    "issued_at",
    "reason",
    "currency",
    "total_excl_vat_minor",
    "vat_amount_minor",
    "total_incl_vat_minor",
)


class PrivacyBillingRefusalError(Exception):
    """The export worker omitted a required workspace binding."""


def _workspace_id(value: UUID | None) -> UUID:
    if value is None:
        raise PrivacyBillingRefusalError("workspace export binding")
    return value


def export_records(
    *, scope: str, organisation_id: UUID | None, identity_ids: tuple[UUID, ...]
) -> Iterator[tuple[str, dict[str, Any]]]:
    if scope == "workspace" and organisation_id is None:
        raise PrivacyBillingRefusalError("workspace export binding")
    orders = (
        Order.objects.filter(organisation_id=_workspace_id(organisation_id))
        if scope == "workspace"
        else Order.objects.filter(placed_by__in=identity_ids)
    )
    for row in orders.order_by("id").values(*ORDER_FIELDS).iterator():
        yield "order", row
    if scope == "workspace":
        for kind, model, fields in (
            ("invoice", Invoice, INVOICE_FIELDS),
            ("credit_note", CreditNote, CREDIT_FIELDS),
        ):
            for row in (
                model.objects.filter(organisation_id=_workspace_id(organisation_id))
                .order_by("id")
                .values(*fields)
                .iterator()
            ):
                yield kind, row


def export_record_permitted(
    *,
    kind: str,
    identifier: UUID,
    scope: str,
    organisation_id: UUID | None,
    identity_ids: tuple[UUID, ...],
) -> bool:
    if scope == "workspace" and organisation_id is None:
        raise PrivacyBillingRefusalError("workspace export binding")
    if kind == "order":
        rows = Order.objects.filter(id=identifier)
        return (
            rows.filter(organisation_id=_workspace_id(organisation_id)).exists()
            if scope == "workspace"
            else rows.filter(placed_by__in=identity_ids).exists()
        )
    if kind in {"invoice", "credit_note"}:
        model = Invoice if kind == "invoice" else CreditNote
        return (
            scope == "workspace"
            and model.objects.filter(
                id=identifier, organisation_id=_workspace_id(organisation_id)
            ).exists()
        )
    return False
