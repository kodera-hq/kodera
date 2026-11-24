# SPDX-License-Identifier: LicenseRef-Kodera-EE
"""Canonical Kodera commercial price schedules and gross-margin floor guard.

All monetary calculations use exact minor-unit integer arithmetic in euro cents (`EUR`).
Floating-point and boolean numeric inputs are rejected with `TypeError`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

PlanCode = Literal["community", "team", "sovereign"]
BillingCycle = Literal["monthly", "annual"]
SovereignInfraTierCode = Literal["PRO2-S", "PRO2-M", "PRO2-L"]

CURRENCY_EUR = "EUR"
BPS_DENOMINATOR = 10_000
MIN_GROSS_MARGIN_BPS = 4_400  # 44.0% minimum gross-margin floor

# Canonical commercial list prices (minor units = euro cents, excl. VAT).
TEAM_ANNUAL_SEAT_MONTHLY_CENTS = 500  # 5.00 EUR / active seat / month, billed annually
TEAM_ANNUAL_SEAT_YEARLY_CENTS = TEAM_ANNUAL_SEAT_MONTHLY_CENTS * 12  # 60.00 EUR / seat / year
TEAM_MONTHLY_SEAT_CENTS = 600  # 6.00 EUR / active seat / month, billed monthly

SOVEREIGN_BASE_MONTHLY_CENTS = 29_000  # 290.00 EUR / month dedicated base
SOVEREIGN_BASE_ANNUAL_CENTS = SOVEREIGN_BASE_MONTHLY_CENTS * 12  # 3,480.00 EUR / year
SOVEREIGN_INCLUDED_SEATS = 25

# Deterministic Scaleway fr-par COGS floor schedules in euro cents per month.
TEAM_COGS_PER_SEAT_MONTHLY_CENTS = 120
SOVEREIGN_PRO2_S_COGS_MONTHLY_CENTS = 6_900  # PRO2-S (4 vCPU, 16 GB RAM, 1..25 seats)
SOVEREIGN_PRO2_M_COGS_MONTHLY_CENTS = 10_900  # PRO2-M (8 vCPU, 32 GB RAM, 26..100 seats)
SOVEREIGN_PRO2_L_COGS_MONTHLY_CENTS = 14_500  # PRO2-L (16 vCPU, 64 GB RAM, 101+ seats)
SOVEREIGN_BASE_COGS_MONTHLY_CENTS = SOVEREIGN_PRO2_S_COGS_MONTHLY_CENTS
SOVEREIGN_EXTRA_SEAT_COGS_MONTHLY_CENTS = 90

MAX_SEATS = 100_000
FR_STANDARD_VAT_BPS = 2_000  # 20.0%


class PricingValidationError(ValueError):
    """Raised when commercial pricing inputs violate domain bounds."""

    code: str

    def __init__(self, message: str, *, code: str = "pricing_validation_error") -> None:
        super().__init__(message)
        self.code = code


class MarginFloorViolationError(PricingValidationError):
    """Raised when a quote's gross margin falls below `MIN_GROSS_MARGIN_BPS` (4400 bps)."""

    def __init__(self, actual_bps: int, required_bps: int = MIN_GROSS_MARGIN_BPS) -> None:
        super().__init__(
            f"gross margin {actual_bps} bps is below the {required_bps} bps commercial floor",
            code="margin_floor_violation",
        )
        self.actual_bps = actual_bps
        self.required_bps = required_bps


@dataclass(frozen=True, slots=True)
class SeatTierBracket:
    """Inclusive seat bracket `[up_to_seats]` with integer minor-unit monthly & annual rates."""

    min_seat: int
    max_seat: int | None
    monthly_seat_cents: int
    annual_seat_monthly_cents: int


SOVEREIGN_SEAT_TIERS: tuple[SeatTierBracket, ...] = (
    SeatTierBracket(
        min_seat=1,
        max_seat=SOVEREIGN_INCLUDED_SEATS,
        monthly_seat_cents=0,
        annual_seat_monthly_cents=0,
    ),
    SeatTierBracket(
        min_seat=26,
        max_seat=100,
        monthly_seat_cents=800,
        annual_seat_monthly_cents=700,
    ),
    SeatTierBracket(
        min_seat=101,
        max_seat=500,
        monthly_seat_cents=600,
        annual_seat_monthly_cents=500,
    ),
    SeatTierBracket(
        min_seat=501,
        max_seat=None,
        monthly_seat_cents=450,
        annual_seat_monthly_cents=400,
    ),
)


@dataclass(frozen=True, slots=True)
class SovereignInfraTier:
    """Deterministic Scaleway `fr-par` dedicated VM sizing bracket and monthly COGS floor."""

    code: SovereignInfraTierCode
    vcpus: int
    ram_gb: int
    min_seats: int
    max_seats: int | None
    base_cogs_monthly_cents: int


SOVEREIGN_INFRA_TIERS: tuple[SovereignInfraTier, ...] = (
    SovereignInfraTier(
        code="PRO2-S",
        vcpus=4,
        ram_gb=16,
        min_seats=1,
        max_seats=25,
        base_cogs_monthly_cents=SOVEREIGN_PRO2_S_COGS_MONTHLY_CENTS,
    ),
    SovereignInfraTier(
        code="PRO2-M",
        vcpus=8,
        ram_gb=32,
        min_seats=26,
        max_seats=100,
        base_cogs_monthly_cents=SOVEREIGN_PRO2_M_COGS_MONTHLY_CENTS,
    ),
    SovereignInfraTier(
        code="PRO2-L",
        vcpus=16,
        ram_gb=64,
        min_seats=101,
        max_seats=None,
        base_cogs_monthly_cents=SOVEREIGN_PRO2_L_COGS_MONTHLY_CENTS,
    ),
)


@dataclass(frozen=True, slots=True)
class CommercialQuote:
    plan_code: PlanCode
    billing_cycle: BillingCycle
    seats: int
    currency: str
    list_excl_vat_minor: int
    discount_bps: int
    net_excl_vat_minor: int
    vat_rate_bps: int
    vat_amount_minor: int
    total_incl_vat_minor: int
    estimated_cogs_minor: int
    gross_margin_bps: int
    vm_shape: str | None = None


PlanQuote = CommercialQuote


def require_strict_int(value: object, field_name: str) -> int:
    """Accept plain `int` only; reject `bool`, `float`, `Decimal`, and strings."""
    if type(value) is not int:
        raise TypeError(f"{field_name} must be an exact int, got {type(value).__name__}")
    return value


def mul_bps_half_up(amount_minor: int, bps: int) -> int:
    """Compute `round_half_up(amount_minor * bps / 10_000)` using integer arithmetic only."""
    require_strict_int(amount_minor, "amount_minor")
    require_strict_int(bps, "bps")
    if amount_minor < 0:
        raise PricingValidationError("amount_minor must be non-negative", code="negative_amount")
    if not 0 <= bps <= BPS_DENOMINATOR:
        raise PricingValidationError("bps must be between 0 and 10000", code="invalid_bps")
    return (amount_minor * bps + (BPS_DENOMINATOR // 2)) // BPS_DENOMINATOR


def compute_vat_minor(amount_excl_vat_minor: int, vat_rate_bps: int) -> int:
    """Compute VAT in integer cents from basis points (`0..10_000`)."""
    return mul_bps_half_up(amount_excl_vat_minor, vat_rate_bps)


def compute_gross_margin_bps(net_revenue_minor: int, cogs_minor: int) -> int:
    """Compute gross margin in integer basis points: `((revenue - cogs) * 10_000) // revenue`."""
    require_strict_int(net_revenue_minor, "net_revenue_minor")
    require_strict_int(cogs_minor, "cogs_minor")
    if cogs_minor < 0:
        raise PricingValidationError("cogs_minor must be non-negative", code="negative_cogs")
    if net_revenue_minor <= 0:
        return -BPS_DENOMINATOR if cogs_minor > 0 else 0
    return ((net_revenue_minor - cogs_minor) * BPS_DENOMINATOR) // net_revenue_minor


def enforce_margin_floor(
    net_revenue_minor: int,
    cogs_minor: int,
    *,
    floor_bps: int = MIN_GROSS_MARGIN_BPS,
) -> int:
    """Verify gross margin >= `floor_bps` (default 4400 bps = 44.0%) and return margin in bps."""
    require_strict_int(floor_bps, "floor_bps")
    margin_bps = compute_gross_margin_bps(net_revenue_minor, cogs_minor)
    if net_revenue_minor <= 0 or margin_bps < floor_bps:
        raise MarginFloorViolationError(actual_bps=margin_bps, required_bps=floor_bps)
    return margin_bps


def _sovereign_seat_overage_minor(seats: int, billing_cycle: BillingCycle) -> int:
    months = 12 if billing_cycle == "annual" else 1
    total = 0
    for tier in SOVEREIGN_SEAT_TIERS:
        if seats < tier.min_seat:
            break
        upper = seats if tier.max_seat is None else min(seats, tier.max_seat)
        tier_seats = upper - tier.min_seat + 1
        rate = (
            tier.annual_seat_monthly_cents if billing_cycle == "annual" else tier.monthly_seat_cents
        )
        total += tier_seats * rate * months
    return total


def select_sovereign_infra_tier(seats: int) -> SovereignInfraTier:
    """Select the Scaleway `fr-par` dedicated instance tier (`PRO2-S`, `PRO2-M`, `PRO2-L`) for `seats`."""
    require_strict_int(seats, "seats")
    if seats < 1 or seats > MAX_SEATS:
        raise PricingValidationError(f"seats must be in 1..{MAX_SEATS}", code="invalid_seats")
    for tier in SOVEREIGN_INFRA_TIERS:
        if tier.max_seats is None or seats <= tier.max_seats:
            return tier
    return SOVEREIGN_INFRA_TIERS[-1]


def estimate_plan_cogs_minor(
    plan_code: PlanCode,
    *,
    seats: int,
    billing_cycle: BillingCycle,
) -> int:
    """Deterministic infrastructure COGS estimate in euro cents for margin floor checks."""
    require_strict_int(seats, "seats")
    if seats < 1 or seats > MAX_SEATS:
        raise PricingValidationError(f"seats must be in 1..{MAX_SEATS}", code="invalid_seats")
    months = 12 if billing_cycle == "annual" else 1
    if plan_code == "community":
        return 0
    if plan_code == "team":
        return seats * TEAM_COGS_PER_SEAT_MONTHLY_CENTS * months
    if plan_code == "sovereign":
        infra_tier = select_sovereign_infra_tier(seats)
        extra_seats = max(0, seats - SOVEREIGN_INCLUDED_SEATS)
        monthly_cogs = (
            infra_tier.base_cogs_monthly_cents
            + extra_seats * SOVEREIGN_EXTRA_SEAT_COGS_MONTHLY_CENTS
        )
        return monthly_cogs * months
    raise PricingValidationError(f"unknown plan_code: {plan_code!r}", code="unknown_plan_code")


def list_price_excl_vat_minor(
    plan_code: PlanCode,
    *,
    seats: int,
    billing_cycle: BillingCycle,
) -> int:
    """Compute canonical undiscounted list price in euro cents (excl. VAT)."""
    require_strict_int(seats, "seats")
    if seats < 1 or seats > MAX_SEATS:
        raise PricingValidationError(f"seats must be in 1..{MAX_SEATS}", code="invalid_seats")
    if billing_cycle not in ("monthly", "annual"):
        raise PricingValidationError(
            f"invalid billing_cycle: {billing_cycle!r}", code="invalid_billing_cycle"
        )

    if plan_code == "community":
        return 0
    if plan_code == "team":
        if billing_cycle == "annual":
            return seats * TEAM_ANNUAL_SEAT_YEARLY_CENTS
        return seats * TEAM_MONTHLY_SEAT_CENTS
    if plan_code == "sovereign":
        base = (
            SOVEREIGN_BASE_ANNUAL_CENTS
            if billing_cycle == "annual"
            else SOVEREIGN_BASE_MONTHLY_CENTS
        )
        return base + _sovereign_seat_overage_minor(seats, billing_cycle)
    raise PricingValidationError(f"unknown plan_code: {plan_code!r}", code="unknown_plan_code")


def catalog_po_subtotal_excl_vat_minor(
    plan_code: PlanCode,
    *,
    seats: int,
    billing_months: int,
    discount_bps: int = 0,
) -> int:
    """Compute server-authoritative catalog subtotal (excl. VAT) for a multi-month PO."""
    require_strict_int(seats, "committed_seats")
    require_strict_int(billing_months, "billing_months")
    require_strict_int(discount_bps, "discount_bps")
    if billing_months not in (1, 12, 24, 36):
        raise PricingValidationError(
            "billing_months must be 1, 12, 24, or 36", code="invalid_billing_months"
        )
    if not 0 <= discount_bps <= BPS_DENOMINATOR:
        raise PricingValidationError(
            "discount_bps must be in 0..10000", code="invalid_discount_bps"
        )
    if billing_months == 1:
        list_minor = list_price_excl_vat_minor(plan_code, seats=seats, billing_cycle="monthly")
    else:
        annual_minor = list_price_excl_vat_minor(plan_code, seats=seats, billing_cycle="annual")
        list_minor = annual_minor * (billing_months // 12)
    discount_minor = mul_bps_half_up(list_minor, discount_bps)
    return list_minor - discount_minor


def quote_plan(
    plan_code: PlanCode,
    *,
    seats: int,
    billing_cycle: BillingCycle = "annual",
    discount_bps: int = 0,
    vat_rate_bps: int = FR_STANDARD_VAT_BPS,
    cogs_override_minor: int | None = None,
    custom_net_excl_vat_minor: int | None = None,
) -> CommercialQuote:
    """Calculate a deterministic commercial quote and enforce the 4400 bps margin floor."""
    require_strict_int(seats, "seats")
    require_strict_int(discount_bps, "discount_bps")
    require_strict_int(vat_rate_bps, "vat_rate_bps")
    if not 0 <= discount_bps <= BPS_DENOMINATOR:
        raise PricingValidationError(
            "discount_bps must be in 0..10000", code="invalid_discount_bps"
        )
    if not 0 <= vat_rate_bps <= BPS_DENOMINATOR:
        raise PricingValidationError(
            "vat_rate_bps must be in 0..10000", code="invalid_vat_rate_bps"
        )

    list_minor = list_price_excl_vat_minor(plan_code, seats=seats, billing_cycle=billing_cycle)
    if custom_net_excl_vat_minor is not None:
        require_strict_int(custom_net_excl_vat_minor, "custom_net_excl_vat_minor")
        if custom_net_excl_vat_minor < 0:
            raise PricingValidationError(
                "custom_net_excl_vat_minor must be non-negative", code="negative_custom_net"
            )
        net_minor = custom_net_excl_vat_minor
    else:
        discount_minor = mul_bps_half_up(list_minor, discount_bps)
        net_minor = list_minor - discount_minor

    catalog_cogs = estimate_plan_cogs_minor(plan_code, seats=seats, billing_cycle=billing_cycle)
    if cogs_override_minor is None:
        cogs_minor = catalog_cogs
    else:
        cogs_minor = require_strict_int(cogs_override_minor, "cogs_override_minor")
        if cogs_minor < 0:
            raise PricingValidationError("cogs_minor must be non-negative", code="negative_cogs")
        if cogs_minor < catalog_cogs:
            raise PricingValidationError(
                "cogs_override_minor cannot understate catalog COGS",
                code="understated_cogs",
            )

    if plan_code == "community":
        if net_minor != 0:
            raise PricingValidationError(
                "community plan carries zero commercial charge", code="community_nonzero_charge"
            )
        margin_bps = 0
    else:
        margin_bps = enforce_margin_floor(net_minor, cogs_minor, floor_bps=MIN_GROSS_MARGIN_BPS)

    vat_minor = compute_vat_minor(net_minor, vat_rate_bps)
    vm_shape = select_sovereign_infra_tier(seats).code if plan_code == "sovereign" else None
    return CommercialQuote(
        plan_code=plan_code,
        billing_cycle=billing_cycle,
        seats=seats,
        currency=CURRENCY_EUR,
        list_excl_vat_minor=list_minor,
        discount_bps=discount_bps,
        net_excl_vat_minor=net_minor,
        vat_rate_bps=vat_rate_bps,
        vat_amount_minor=vat_minor,
        total_incl_vat_minor=net_minor + vat_minor,
        estimated_cogs_minor=cogs_minor,
        gross_margin_bps=margin_bps,
        vm_shape=vm_shape,
    )


def commercial_schedule_summary() -> dict[str, object]:
    """Serializable summary of Kodera commercial schedules for Enterprise API consumers."""
    return {
        "currency": CURRENCY_EUR,
        "min_gross_margin_bps": MIN_GROSS_MARGIN_BPS,
        "plans": [
            {
                "code": "community",
                "name": "Community",
                "hosting": "self-host",
                "monthly_unit_minor": 0,
                "annual_monthly_equivalent_minor": 0,
            },
            {
                "code": "team",
                "name": "Team",
                "hosting": "cloud-shared",
                "billing_unit": "active_seat",
                "monthly_unit_minor": TEAM_MONTHLY_SEAT_CENTS,
                "annual_monthly_equivalent_minor": TEAM_ANNUAL_SEAT_MONTHLY_CENTS,
                "annual_yearly_unit_minor": TEAM_ANNUAL_SEAT_YEARLY_CENTS,
            },
            {
                "code": "sovereign",
                "name": "Sovereign",
                "hosting": "dedicated-tenant",
                "base_monthly_minor": SOVEREIGN_BASE_MONTHLY_CENTS,
                "base_annual_minor": SOVEREIGN_BASE_ANNUAL_CENTS,
                "included_seats": SOVEREIGN_INCLUDED_SEATS,
                "seat_tiers": [
                    {
                        "min_seat": tier.min_seat,
                        "max_seat": tier.max_seat,
                        "monthly_seat_minor": tier.monthly_seat_cents,
                        "annual_seat_monthly_minor": tier.annual_seat_monthly_cents,
                    }
                    for tier in SOVEREIGN_SEAT_TIERS
                ],
                "infra_tiers": [
                    {
                        "code": tier.code,
                        "vcpus": tier.vcpus,
                        "ram_gb": tier.ram_gb,
                        "min_seats": tier.min_seats,
                        "max_seats": tier.max_seats,
                        "base_cogs_monthly_minor": tier.base_cogs_monthly_cents,
                    }
                    for tier in SOVEREIGN_INFRA_TIERS
                ],
            },
        ],
    }
