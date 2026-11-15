# SPDX-License-Identifier: LicenseRef-Kodera-EE
"""Enterprise custom Purchase Order (PO) lifecycle, commitment enforcement, and invoice binding.

Every mutating or reading operation checks ``KODERA_EDITION=enterprise`` dynamically.
All monetary fields are integer minor units in euro cents (`EUR`). Backed by PostgreSQL
(`ee/billing/storage.py`) in multi-worker environments, with optional in-memory storage
for isolated unit tests.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

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
from .storage import (
    CallerAuthority,
    PurchaseOrderStore,
    StorageBackend,
    build_purchase_order_store,
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

_ALNUM_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")
_ORG_ID_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
_CUSTOMER_PO_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._/-")
_UPPER_ALPHA_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
_ASCII_DIGITS = frozenset("0123456789")


class PurchaseOrderError(Exception):
    """Base error for Enterprise Purchase Order domain rules."""

    code: str

    def __init__(self, message: str, *, code: str = "purchase_order_error") -> None:
        super().__init__(message)
        self.code = code


class PurchaseOrderValidationError(PurchaseOrderError):
    """Raised when PO fields, invoice references, or amounts fail validation."""

    def __init__(self, message: str, *, code: str = "purchase_order_validation_error") -> None:
        super().__init__(message, code=code)


class PurchaseOrderNotFoundError(PurchaseOrderError):
    """Raised when a PO identifier does not exist."""

    def __init__(self, message: str) -> None:
        super().__init__(message, code="purchase_order_not_found")


class InvalidPurchaseOrderTransitionError(PurchaseOrderError):
    """Raised when a PO transition is not permitted from its current state."""

    def __init__(self, current: PurchaseOrderState, requested: PurchaseOrderState) -> None:
        super().__init__(
            f"purchase_order: {current} -> {requested} is not a valid transition",
            code="purchase_order_invalid_transition",
        )
        self.current = current
        self.requested = requested


class CommitmentExceededError(PurchaseOrderError):
    """Raised when seat or storage usage exceeds contracted PO commitments under hard enforcement."""

    def __init__(self, message: str) -> None:
        super().__init__(message, code="purchase_order_commitment_exceeded")


class PurchaseOrderForbiddenError(PurchaseOrderError):
    """Raised when a non-operator caller attempts to settle a PO invoice or payment."""

    def __init__(self, message: str) -> None:
        super().__init__(message, code="purchase_order_forbidden")


SettlementActorLane = Literal["staff", "internal", "customer"]


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
    countersigned_by_user_id: str | None = None
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


def _is_org_id(value: object) -> bool:
    return (
        isinstance(value, str)
        and 2 <= len(value) <= 64
        and all(ch in _ORG_ID_CHARS for ch in value)
    )


def _is_customer_po_ref(value: object) -> bool:
    return (
        isinstance(value, str)
        and 2 <= len(value) <= 64
        and value[0] in _ALNUM_CHARS
        and all(ch in _CUSTOMER_PO_CHARS for ch in value)
    )


def validate_invoice_reference(invoice_ref: str) -> str:
    """Validate canonical legal invoice reference (`INV-<SERIES>-<YYYY>-<NNNNN>`) in O(n)."""
    if not isinstance(invoice_ref, str) or not 16 <= len(invoice_ref) <= 32:
        raise PurchaseOrderValidationError(
            "invoice_ref must match canonical legal format INV-<SERIES>-<YYYY>-<NNNNN>",
            code="invalid_invoice_ref",
        )
    parts = invoice_ref.split("-")
    if len(parts) not in (4, 5) or parts[0] != "INV":
        raise PurchaseOrderValidationError(
            "invoice_ref must match canonical legal format INV-<SERIES>-<YYYY>-<NNNNN>",
            code="invalid_invoice_ref",
        )
    series_segments = parts[1:-2]
    year_seg = parts[-2]
    seq_seg = parts[-1]
    if (
        len(year_seg) != 4
        or any(ch not in _ASCII_DIGITS for ch in year_seg)
        or len(seq_seg) != 5
        or any(ch not in _ASCII_DIGITS for ch in seq_seg)
        or any(
            not (2 <= len(seg) <= 8 and all(ch in _UPPER_ALPHA_CHARS for ch in seg))
            for seg in series_segments
        )
    ):
        raise PurchaseOrderValidationError(
            "invoice_ref must match canonical legal format INV-<SERIES>-<YYYY>-<NNNNN>",
            code="invalid_invoice_ref",
        )
    return invoice_ref


class PurchaseOrderBook:
    """Deterministic Enterprise Purchase Order ledger and lifecycle state machine."""

    def __init__(
        self,
        *,
        backend: StorageBackend = "auto",
        store: PurchaseOrderStore | None = None,
    ) -> None:
        self._store: PurchaseOrderStore = (
            store if store is not None else build_purchase_order_store(backend)
        )

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
        authority: CallerAuthority | None = None,
        environ: Mapping[str, str] | None = None,
    ) -> PurchaseOrder:
        require_enterprise_edition(environ)
        if not _is_org_id(organisation_id):
            raise PurchaseOrderValidationError(
                "invalid organisation_id", code="invalid_organisation_id"
            )
        if not _is_customer_po_ref(customer_po_reference):
            raise PurchaseOrderValidationError(
                "invalid customer_po_reference", code="invalid_customer_po_reference"
            )
        if plan_code not in ("team", "sovereign"):
            raise PurchaseOrderValidationError(
                "enterprise PO requires plan_code team or sovereign", code="invalid_plan_code"
            )

        require_strict_int(billing_months, "billing_months")
        require_strict_int(committed_seats, "committed_seats")
        require_strict_int(committed_storage_gb, "committed_storage_gb")
        require_strict_int(subtotal_excl_vat_minor, "subtotal_excl_vat_minor")
        require_strict_int(vat_rate_bps, "vat_rate_bps")

        if billing_months not in (1, 12, 24, 36):
            raise PurchaseOrderValidationError(
                "billing_months must be 1, 12, 24, or 36", code="invalid_billing_months"
            )
        if committed_seats < 1 or committed_seats > 100_000:
            raise PurchaseOrderValidationError(
                "committed_seats must be in 1..100000", code="invalid_committed_seats"
            )
        if committed_storage_gb < 1 or committed_storage_gb > 1_000_000:
            raise PurchaseOrderValidationError(
                "committed_storage_gb must be in 1..1000000", code="invalid_committed_storage"
            )
        if subtotal_excl_vat_minor <= 0:
            raise PurchaseOrderValidationError(
                "subtotal_excl_vat_minor must be positive", code="invalid_subtotal"
            )
        if not 0 <= vat_rate_bps <= 10_000:
            raise PurchaseOrderValidationError(
                "vat_rate_bps must be in 0..10000", code="invalid_vat_rate_bps"
            )

        now = created_at or datetime.now(UTC)
        if expires_at <= now:
            raise PurchaseOrderValidationError(
                "expires_at must be strictly after created_at", code="invalid_expiry"
            )

        if estimated_cogs_minor is None:
            monthly_cogs = estimate_plan_cogs_minor(
                plan_code, seats=committed_seats, billing_cycle="monthly"
            )
            cogs = monthly_cogs * billing_months
        else:
            cogs = require_strict_int(estimated_cogs_minor, "estimated_cogs_minor")
            if cogs < 0:
                raise PurchaseOrderValidationError(
                    "estimated_cogs_minor must be non-negative", code="negative_cogs"
                )

        margin_bps = enforce_margin_floor(
            subtotal_excl_vat_minor, cogs, floor_bps=MIN_GROSS_MARGIN_BPS
        )
        vat_minor = compute_vat_minor(subtotal_excl_vat_minor, vat_rate_bps)

        def _build(po_id: str, po_number: str) -> PurchaseOrder:
            return PurchaseOrder(
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

        return self._store.create_draft(
            year=now.year,
            draft_builder=_build,
            organisation_id=organisation_id,
            authority=authority,
        )

    def get(
        self,
        po_id: str,
        *,
        authority: CallerAuthority | None = None,
        environ: Mapping[str, str] | None = None,
    ) -> PurchaseOrder:
        require_enterprise_edition(environ)
        return self._store.get(po_id, authority=authority)

    def issue(
        self,
        po_id: str,
        *,
        at: datetime | None = None,
        authority: CallerAuthority | None = None,
        environ: Mapping[str, str] | None = None,
    ) -> PurchaseOrder:
        require_enterprise_edition(environ)
        now = at or datetime.now(UTC)

        def _mutate(
            po: PurchaseOrder,
        ) -> tuple[PurchaseOrder | None, tuple[PurchaseOrder, Exception] | None]:
            if po.state in ("draft", "issued") and now >= po.expires_at:
                expired_po = replace(po, state="expired", expired_at=now)
                return None, (
                    expired_po,
                    InvalidPurchaseOrderTransitionError("expired", "issued"),
                )
            self._require_transition(po.state, "issued")
            return replace(po, state="issued", issued_at=now), None

        return self._store.mutate(po_id, _mutate, authority=authority)

    def countersign(
        self,
        po_id: str,
        *,
        signatory: str,
        at: datetime | None = None,
        authority: CallerAuthority | None = None,
        environ: Mapping[str, str] | None = None,
    ) -> PurchaseOrder:
        require_enterprise_edition(environ)
        signatory_user_id: str | None = None
        if authority is not None:
            if authority.lane != "customer":
                raise PurchaseOrderForbiddenError(
                    "only an authenticated customer signatory may countersign a purchase order"
                )
            if authority.user_id is not None:
                try:
                    signatory_user_id = str(UUID(authority.user_id))
                except ValueError as exc:
                    raise PurchaseOrderForbiddenError(
                        "authenticated customer signatory requires verified user_id"
                    ) from exc
            elif authority.live_authority:
                raise PurchaseOrderForbiddenError(
                    "authenticated customer signatory requires verified user_id"
                )
        now = at or datetime.now(UTC)

        def _mutate(
            po: PurchaseOrder,
        ) -> tuple[PurchaseOrder | None, tuple[PurchaseOrder, Exception] | None]:
            if not isinstance(signatory, str) or not (2 <= len(signatory.strip()) <= 120):
                raise PurchaseOrderValidationError(
                    "signatory must be 2..120 non-blank characters", code="invalid_signatory"
                )
            clean_signatory = signatory.strip()
            if po.state in ("draft", "issued") and now >= po.expires_at:
                expired_po = replace(po, state="expired", expired_at=now)
                return None, (
                    expired_po,
                    InvalidPurchaseOrderTransitionError("expired", "countersigned"),
                )
            self._require_transition(po.state, "countersigned")
            return (
                replace(
                    po,
                    state="countersigned",
                    countersigned_at=now,
                    countersigned_by=clean_signatory,
                    countersigned_by_user_id=signatory_user_id,
                ),
                None,
            )

        return self._store.mutate(po_id, _mutate, authority=authority)

    def bind_invoice(
        self,
        po_id: str,
        *,
        invoice_ref: str,
        actor_lane: SettlementActorLane = "customer",
        at: datetime | None = None,
        authority: CallerAuthority | None = None,
        environ: Mapping[str, str] | None = None,
    ) -> PurchaseOrder:
        require_enterprise_edition(environ)
        if actor_lane not in ("staff", "internal"):
            raise PurchaseOrderForbiddenError(
                "only operator or staff authority may bind a legal Core invoice to a purchase order"
            )
        validated_ref = validate_invoice_reference(invoice_ref)
        now = at or datetime.now(UTC)

        def _mutate(
            po: PurchaseOrder,
        ) -> tuple[PurchaseOrder | None, tuple[PurchaseOrder, Exception] | None]:
            self._require_transition(po.state, "invoiced")
            self._store.verify_core_invoice(po=po, invoice_ref=validated_ref)
            return (
                replace(
                    po,
                    state="invoiced",
                    invoice_ref=validated_ref,
                    invoiced_at=now,
                ),
                None,
            )

        return self._store.mutate(po_id, _mutate, authority=authority)

    def mark_paid(
        self,
        po_id: str,
        *,
        invoice_ref: str,
        payment_ref: str,
        amount_paid_minor: int,
        actor_lane: SettlementActorLane = "customer",
        at: datetime | None = None,
        authority: CallerAuthority | None = None,
        environ: Mapping[str, str] | None = None,
    ) -> PurchaseOrder:
        require_enterprise_edition(environ)
        if actor_lane not in ("staff", "internal"):
            raise PurchaseOrderForbiddenError(
                "only operator or staff authority may mark a purchase order paid"
            )
        validated_ref = validate_invoice_reference(invoice_ref)
        if not isinstance(payment_ref, str) or not (3 <= len(payment_ref.strip()) <= 128):
            raise PurchaseOrderValidationError(
                "payment_ref must be 3..128 characters", code="invalid_payment_ref"
            )
        require_strict_int(amount_paid_minor, "amount_paid_minor")
        now = at or datetime.now(UTC)
        clean_payment_ref = payment_ref.strip()

        def _mutate(
            po: PurchaseOrder,
        ) -> tuple[PurchaseOrder | None, tuple[PurchaseOrder, Exception] | None]:
            self._require_transition(po.state, "paid")
            if po.invoice_ref != validated_ref:
                raise PurchaseOrderValidationError(
                    "invoice_ref does not match the bound purchase order invoice",
                    code="mismatched_invoice_ref",
                )
            if amount_paid_minor != po.total_incl_vat_minor:
                raise PurchaseOrderValidationError(
                    "amount_paid_minor must equal total_incl_vat_minor",
                    code="mismatched_payment_amount",
                )
            self._store.verify_core_payment(
                po=po,
                invoice_ref=validated_ref,
                payment_ref=clean_payment_ref,
                amount_paid_minor=amount_paid_minor,
            )
            return (
                replace(
                    po,
                    state="paid",
                    payment_ref=clean_payment_ref,
                    paid_at=now,
                ),
                None,
            )

        return self._store.mutate(po_id, _mutate, authority=authority)

    def register_core_invoice(
        self,
        number: str,
        *,
        organisation_id: str,
        total_incl_vat_minor: int,
        currency: str = "EUR",
        state: str = "issued",
    ) -> None:
        """Seed a Core `billing_invoice` fixture in isolated `backend='memory'` unit tests."""
        registrar = getattr(self._store, "register_core_invoice", None)
        if not callable(registrar):
            raise RuntimeError("register_core_invoice is only supported on memory stores")
        registrar(
            number,
            organisation_id=organisation_id,
            total_incl_vat_minor=total_incl_vat_minor,
            currency=currency,
            state=state,
        )

    def register_core_payment(
        self,
        invoice_number: str,
        payment_ref: str,
        *,
        organisation_id: str,
        amount_minor: int,
        currency: str = "EUR",
        state: str = "succeeded",
        allocated: bool = True,
        mark_invoice_paid: bool = True,
    ) -> None:
        """Seed a Core `billing_payment` fixture in isolated `backend='memory'` unit tests."""
        registrar = getattr(self._store, "register_core_payment", None)
        if not callable(registrar):
            raise RuntimeError("register_core_payment is only supported on memory stores")
        registrar(
            invoice_number,
            payment_ref,
            organisation_id=organisation_id,
            amount_minor=amount_minor,
            currency=currency,
            state=state,
            allocated=allocated,
            mark_invoice_paid=mark_invoice_paid,
        )

    def expire(
        self,
        po_id: str,
        *,
        at: datetime | None = None,
        authority: CallerAuthority | None = None,
        environ: Mapping[str, str] | None = None,
    ) -> PurchaseOrder:
        require_enterprise_edition(environ)
        now = at or datetime.now(UTC)

        def _mutate(
            po: PurchaseOrder,
        ) -> tuple[PurchaseOrder | None, tuple[PurchaseOrder, Exception] | None]:
            self._require_transition(po.state, "expired")
            return replace(po, state="expired", expired_at=now), None

        return self._store.mutate(po_id, _mutate, authority=authority)

    def evaluate_commitment(
        self,
        po_id: str,
        *,
        active_seats: int,
        used_storage_gb: int,
        enforce_hard_cap: bool = True,
        authority: CallerAuthority | None = None,
        environ: Mapping[str, str] | None = None,
    ) -> CommitmentEvaluation:
        """Validate active seat and storage consumption against a countersigned/invoiced/paid PO."""
        require_enterprise_edition(environ)
        po = self._store.get(po_id, authority=authority)
        require_strict_int(active_seats, "active_seats")
        require_strict_int(used_storage_gb, "used_storage_gb")
        if active_seats < 0 or used_storage_gb < 0:
            raise PurchaseOrderValidationError(
                "usage metrics must be non-negative", code="negative_usage_metrics"
            )
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

    @staticmethod
    def _require_transition(current: PurchaseOrderState, requested: PurchaseOrderState) -> None:
        if requested not in PO_TRANSITIONS[current]:
            raise InvalidPurchaseOrderTransitionError(current, requested)
