# SPDX-License-Identifier: LicenseRef-Kodera-EE
"""Enterprise custom Purchase Order (PO) lifecycle, commitment enforcement, and invoice binding.

Every mutating or reading operation checks ``KODERA_EDITION=enterprise`` dynamically.
All monetary fields are integer minor units in euro cents (`EUR`).
"""

from __future__ import annotations

import re
import threading
from collections.abc import Mapping
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Literal

from . import require_enterprise_edition
from .pricing import (
    CURRENCY_EUR,
    FR_STANDARD_VAT_BPS,
    MIN_GROSS_MARGIN_BPS,
    PlanCode,
    compute_vat_minor,
    enforce_margin_floor,
    estimate_plan_cogs_minor,
    require_strict_int,
)

PurchaseOrderState = Literal[
    "draft",
    "issued",
    "countersigned",
    "invoiced",
    "paid",
    "expired",
]

PO_TRANSITIONS: dict[PurchaseOrderState, frozenset[PurchaseOrderState]] = {
    "draft": frozenset({"issued", "expired"}),
    "issued": frozenset({"countersigned", "expired"}),
    "countersigned": frozenset({"invoiced", "expired"}),
    "invoiced": frozenset({"paid", "expired"}),
    "paid": frozenset(),
    "expired": frozenset(),
}

PO_NUMBER_RE = re.compile(r"^PO-[0-9]{4}-[0-9]{5}\Z")
CUSTOMER_PO_REF_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{1,63}\Z")
INVOICE_REF_RE = re.compile(r"^INV-[A-Z]{2,8}(?:-[A-Z]{2,8})?-[0-9]{4}-[0-9]{5}\Z")
ORG_ID_RE = re.compile(r"^[A-Za-z0-9_-]{2,64}\Z")


class PurchaseOrderError(Exception):
    """Base error for Enterprise Purchase Order domain rules."""


class PurchaseOrderValidationError(PurchaseOrderError):
    """Raised when PO fields, invoice references, or amounts fail validation."""


class PurchaseOrderNotFoundError(PurchaseOrderError):
    """Raised when a PO identifier does not exist."""


class InvalidPurchaseOrderTransitionError(PurchaseOrderError):
    """Raised when a PO transition is not permitted from its current state."""

    def __init__(self, current: PurchaseOrderState, requested: PurchaseOrderState) -> None:
        super().__init__(f"purchase_order: {current} -> {requested} is not a valid transition")
        self.current = current
        self.requested = requested


class CommitmentExceededError(PurchaseOrderError):
    """Raised when seat or storage usage exceeds contracted PO commitments under hard enforcement."""


@dataclass(frozen=True, slots=True)
class PurchaseOrder:
    po_id: str
    po_number: str
    organisation_id: str
    customer_po_reference: str
    plan_code: PlanCode
    billing_months: int
    committed_seats: int
    committed_storage_gb: int
    subtotal_excl_vat_minor: int
    vat_rate_bps: int
    vat_amount_minor: int
    total_incl_vat_minor: int
    estimated_cogs_minor: int
    gross_margin_bps: int
    currency: str
    state: PurchaseOrderState
    created_at: datetime
    expires_at: datetime
    issued_at: datetime | None = None
    countersigned_at: datetime | None = None
    countersigned_by: str | None = None
    invoice_ref: str | None = None
    invoiced_at: datetime | None = None
    payment_ref: str | None = None
    paid_at: datetime | None = None
    expired_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class CommitmentEvaluation:
    po_id: str
    state: PurchaseOrderState
    active_seats: int
    committed_seats: int
    seat_overage: int
    used_storage_gb: int
    committed_storage_gb: int
    storage_overage_gb: int
    within_commitment: bool


def validate_invoice_reference(invoice_ref: str) -> str:
    """Validate canonical legal invoice reference (`INV-<SERIES>-<YYYY>-<NNNNN>`)."""
    if not isinstance(invoice_ref, str) or INVOICE_REF_RE.fullmatch(invoice_ref) is None:
        raise PurchaseOrderValidationError(
            "invoice_ref must match canonical legal format INV-<SERIES>-<YYYY>-<NNNNN>"
        )
    return invoice_ref


class PurchaseOrderBook:
    """Deterministic Enterprise Purchase Order ledger and lifecycle state machine."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._seq = 0
        self._orders: dict[str, PurchaseOrder] = {}
        self._invoice_refs: dict[str, str] = {}

    def create_draft(
        self,
        *,
        organisation_id: str,
        customer_po_reference: str,
        plan_code: PlanCode = "sovereign",
        billing_months: int = 12,
        committed_seats: int,
        committed_storage_gb: int,
        subtotal_excl_vat_minor: int,
        vat_rate_bps: int = FR_STANDARD_VAT_BPS,
        estimated_cogs_minor: int | None = None,
        created_at: datetime | None = None,
        expires_at: datetime,
        environ: Mapping[str, str] | None = None,
    ) -> PurchaseOrder:
        require_enterprise_edition(environ)
        if not isinstance(organisation_id, str) or ORG_ID_RE.fullmatch(organisation_id) is None:
            raise PurchaseOrderValidationError("invalid organisation_id")
        if (
            not isinstance(customer_po_reference, str)
            or CUSTOMER_PO_REF_RE.fullmatch(customer_po_reference) is None
        ):
            raise PurchaseOrderValidationError("invalid customer_po_reference")
        if plan_code not in ("team", "sovereign"):
            raise PurchaseOrderValidationError("enterprise PO requires plan_code team or sovereign")

        require_strict_int(billing_months, "billing_months")
        require_strict_int(committed_seats, "committed_seats")
        require_strict_int(committed_storage_gb, "committed_storage_gb")
        require_strict_int(subtotal_excl_vat_minor, "subtotal_excl_vat_minor")
        require_strict_int(vat_rate_bps, "vat_rate_bps")

        if billing_months not in (1, 12, 24, 36):
            raise PurchaseOrderValidationError("billing_months must be 1, 12, 24, or 36")
        if committed_seats < 1 or committed_seats > 100_000:
            raise PurchaseOrderValidationError("committed_seats must be in 1..100000")
        if committed_storage_gb < 1 or committed_storage_gb > 1_000_000:
            raise PurchaseOrderValidationError("committed_storage_gb must be in 1..1000000")
        if subtotal_excl_vat_minor <= 0:
            raise PurchaseOrderValidationError("subtotal_excl_vat_minor must be positive")
        if not 0 <= vat_rate_bps <= 10_000:
            raise PurchaseOrderValidationError("vat_rate_bps must be in 0..10000")

        now = created_at or datetime.now(UTC)
        if expires_at <= now:
            raise PurchaseOrderValidationError("expires_at must be strictly after created_at")

        if estimated_cogs_minor is None:
            monthly_cogs = estimate_plan_cogs_minor(
                plan_code, seats=committed_seats, billing_cycle="monthly"
            )
            cogs = monthly_cogs * billing_months
        else:
            cogs = require_strict_int(estimated_cogs_minor, "estimated_cogs_minor")
            if cogs < 0:
                raise PurchaseOrderValidationError("estimated_cogs_minor must be non-negative")

        margin_bps = enforce_margin_floor(
            subtotal_excl_vat_minor, cogs, floor_bps=MIN_GROSS_MARGIN_BPS
        )
        vat_minor = compute_vat_minor(subtotal_excl_vat_minor, vat_rate_bps)

        with self._lock:
            self._seq += 1
            year = now.year
            po_id = f"po_{year}_{self._seq:05d}"
            po_number = f"PO-{year}-{self._seq:05d}"
            po = PurchaseOrder(
                po_id=po_id,
                po_number=po_number,
                organisation_id=organisation_id,
                customer_po_reference=customer_po_reference,
                plan_code=plan_code,
                billing_months=billing_months,
                committed_seats=committed_seats,
                committed_storage_gb=committed_storage_gb,
                subtotal_excl_vat_minor=subtotal_excl_vat_minor,
                vat_rate_bps=vat_rate_bps,
                vat_amount_minor=vat_minor,
                total_incl_vat_minor=subtotal_excl_vat_minor + vat_minor,
                estimated_cogs_minor=cogs,
                gross_margin_bps=margin_bps,
                currency=CURRENCY_EUR,
                state="draft",
                created_at=now,
                expires_at=expires_at,
            )
            self._orders[po_id] = po
            return po

    def get(self, po_id: str, *, environ: Mapping[str, str] | None = None) -> PurchaseOrder:
        require_enterprise_edition(environ)
        with self._lock:
            return self._get_locked(po_id)

    def issue(
        self,
        po_id: str,
        *,
        at: datetime | None = None,
        environ: Mapping[str, str] | None = None,
    ) -> PurchaseOrder:
        require_enterprise_edition(environ)
        now = at or datetime.now(UTC)
        with self._lock:
            po = self._get_locked(po_id)
            self._check_not_past_expiry(po, now)
            self._require_transition(po.state, "issued")
            updated = replace(po, state="issued", issued_at=now)
            self._orders[po_id] = updated
            return updated

    def countersign(
        self,
        po_id: str,
        *,
        signatory: str,
        at: datetime | None = None,
        environ: Mapping[str, str] | None = None,
    ) -> PurchaseOrder:
        require_enterprise_edition(environ)
        if not isinstance(signatory, str) or not (2 <= len(signatory.strip()) <= 120):
            raise PurchaseOrderValidationError("signatory must be 2..120 non-blank characters")
        now = at or datetime.now(UTC)
        with self._lock:
            po = self._get_locked(po_id)
            self._check_not_past_expiry(po, now)
            self._require_transition(po.state, "countersigned")
            updated = replace(
                po,
                state="countersigned",
                countersigned_at=now,
                countersigned_by=signatory.strip(),
            )
            self._orders[po_id] = updated
            return updated

    def bind_invoice(
        self,
        po_id: str,
        *,
        invoice_ref: str,
        at: datetime | None = None,
        environ: Mapping[str, str] | None = None,
    ) -> PurchaseOrder:
        require_enterprise_edition(environ)
        validated_ref = validate_invoice_reference(invoice_ref)
        now = at or datetime.now(UTC)
        with self._lock:
            po = self._get_locked(po_id)
            self._require_transition(po.state, "invoiced")
            bound_owner = self._invoice_refs.get(validated_ref)
            if bound_owner is not None and bound_owner != po_id:
                raise PurchaseOrderValidationError(
                    f"invoice_ref {validated_ref} is already bound to another purchase order"
                )
            updated = replace(
                po,
                state="invoiced",
                invoice_ref=validated_ref,
                invoiced_at=now,
            )
            self._orders[po_id] = updated
            self._invoice_refs[validated_ref] = po_id
            return updated

    def mark_paid(
        self,
        po_id: str,
        *,
        invoice_ref: str,
        payment_ref: str,
        amount_paid_minor: int,
        at: datetime | None = None,
        environ: Mapping[str, str] | None = None,
    ) -> PurchaseOrder:
        require_enterprise_edition(environ)
        validated_ref = validate_invoice_reference(invoice_ref)
        if not isinstance(payment_ref, str) or not (3 <= len(payment_ref.strip()) <= 128):
            raise PurchaseOrderValidationError("payment_ref must be 3..128 characters")
        require_strict_int(amount_paid_minor, "amount_paid_minor")
        now = at or datetime.now(UTC)
        with self._lock:
            po = self._get_locked(po_id)
            self._require_transition(po.state, "paid")
            if po.invoice_ref != validated_ref:
                raise PurchaseOrderValidationError(
                    "invoice_ref does not match the bound purchase order invoice"
                )
            if amount_paid_minor != po.total_incl_vat_minor:
                raise PurchaseOrderValidationError(
                    "amount_paid_minor must equal total_incl_vat_minor"
                )
            updated = replace(
                po,
                state="paid",
                payment_ref=payment_ref.strip(),
                paid_at=now,
            )
            self._orders[po_id] = updated
            return updated

    def expire(
        self,
        po_id: str,
        *,
        at: datetime | None = None,
        environ: Mapping[str, str] | None = None,
    ) -> PurchaseOrder:
        require_enterprise_edition(environ)
        now = at or datetime.now(UTC)
        with self._lock:
            po = self._get_locked(po_id)
            self._require_transition(po.state, "expired")
            updated = replace(po, state="expired", expired_at=now)
            self._orders[po_id] = updated
            return updated

    def evaluate_commitment(
        self,
        po_id: str,
        *,
        active_seats: int,
        used_storage_gb: int,
        enforce_hard_cap: bool = True,
        environ: Mapping[str, str] | None = None,
    ) -> CommitmentEvaluation:
        """Validate active seat and storage consumption against a countersigned/invoiced/paid PO."""
        require_enterprise_edition(environ)
        require_strict_int(active_seats, "active_seats")
        require_strict_int(used_storage_gb, "used_storage_gb")
        if active_seats < 0 or used_storage_gb < 0:
            raise PurchaseOrderValidationError("usage metrics must be non-negative")

        with self._lock:
            po = self._get_locked(po_id)
            if po.state not in ("countersigned", "invoiced", "paid"):
                raise InvalidPurchaseOrderTransitionError(po.state, "countersigned")

            seat_overage = max(0, active_seats - po.committed_seats)
            storage_overage = max(0, used_storage_gb - po.committed_storage_gb)
            within = seat_overage == 0 and storage_overage == 0
            if enforce_hard_cap and not within:
                raise CommitmentExceededError(
                    f"PO {po.po_number} commitment exceeded: "
                    f"seat_overage={seat_overage}, storage_overage_gb={storage_overage}"
                )
            return CommitmentEvaluation(
                po_id=po.po_id,
                state=po.state,
                active_seats=active_seats,
                committed_seats=po.committed_seats,
                seat_overage=seat_overage,
                used_storage_gb=used_storage_gb,
                committed_storage_gb=po.committed_storage_gb,
                storage_overage_gb=storage_overage,
                within_commitment=within,
            )

    def _get_locked(self, po_id: str) -> PurchaseOrder:
        po = self._orders.get(po_id)
        if po is None:
            raise PurchaseOrderNotFoundError(f"unknown purchase order: {po_id}")
        return po

    @staticmethod
    def _require_transition(current: PurchaseOrderState, requested: PurchaseOrderState) -> None:
        if requested not in PO_TRANSITIONS[current]:
            raise InvalidPurchaseOrderTransitionError(current, requested)

    def _check_not_past_expiry(self, po: PurchaseOrder, now: datetime) -> None:
        if (
            now >= po.expires_at
            and po.state in PO_TRANSITIONS
            and "expired" in PO_TRANSITIONS[po.state]
        ):
            expired = replace(po, state="expired", expired_at=now)
            self._orders[po.po_id] = expired
            raise InvalidPurchaseOrderTransitionError("expired", "issued")
