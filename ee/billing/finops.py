# SPDX-License-Identifier: LicenseRef-Kodera-EE
"""Per-tenant FinOps infrastructure COGS attribution and provider invoice reconciliation.

All monetary inputs and outputs are exact integer minor units (`EUR` euro cents).
Floating-point and boolean numeric values are rejected by `require_strict_int`.
Pool allocations use deterministic proportional integer floor division:
    `(pool_minor * tenant_usage) // total_usage`
never inventing fractional cents and never exceeding pool subtotals. Any unattributed
idle warm-pool capacity, control-plane overhead, and integer floor remainder is surfaced
explicitly in `unallocated_remainder_minor` so `allocated_total_minor + unallocated_remainder_minor`
reconciles identically to `provider_invoice_total_minor`.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from typing import Any

from .pricing import (
    BPS_DENOMINATOR,
    CURRENCY_EUR,
    MIN_GROSS_MARGIN_BPS,
    PricingValidationError,
    compute_gross_margin_bps,
    require_strict_int,
)

# 1 millicore-second weighted at 1 MiB-second (1,048,576 byte-seconds) so 1 vCPU-s (~1000m)
# carries parity with ~1 GiB-s while preserving exact integer ratios on single-driver inputs.
DEFAULT_CPU_MILLICORE_WEIGHT = 1_048_576
DEFAULT_RAM_BYTE_WEIGHT = 1
DEFAULT_S3_STORAGE_WEIGHT = 1
DEFAULT_S3_EGRESS_WEIGHT = 1
MAX_FINOPS_TENANTS = 10_000

_ORG_ID_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-:")


class FinOpsValidationError(PricingValidationError):
    """Raised when FinOps metering, pool subtotals, or invoice reconciliation invariants fail."""

    def __init__(self, message: str, *, code: str = "finops_validation_error") -> None:
        super().__init__(message, code=code)


def _validate_org_id(value: object) -> str:
    if not isinstance(value, str) or not (1 <= len(value) <= 128):
        raise FinOpsValidationError(
            "organisation_id must be 1 to 128 ASCII identifier characters",
            code="invalid_organisation_id",
        )
    if any(ch not in _ORG_ID_CHARS for ch in value):
        raise FinOpsValidationError(
            "organisation_id contains unsupported characters",
            code="invalid_organisation_id",
        )
    return value


def _validate_optional_ascii_token(
    value: object,
    *,
    field_name: str,
    max_len: int,
    code: str,
) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string or null")
    if not (1 <= len(value) <= max_len) or any(ord(ch) < 0x21 or ord(ch) > 0x7E for ch in value):
        raise FinOpsValidationError(
            f"{field_name} must be 1 to {max_len} printable non-whitespace ASCII characters",
            code=code,
        )
    return value


def _require_non_negative_int(value: object, field_name: str, *, code: str) -> int:
    checked = require_strict_int(value, field_name)
    if checked < 0:
        raise FinOpsValidationError(f"{field_name} must be non-negative", code=code)
    return checked


def _require_positive_weight(value: object, field_name: str) -> int:
    checked = require_strict_int(value, field_name)
    if checked < 1:
        raise FinOpsValidationError(
            f"{field_name} must be at least 1",
            code="invalid_pool_weight",
        )
    return checked


@dataclass(frozen=True, slots=True)
class TenantResourceUsage:
    """Metered integer infrastructure consumption and net revenue for a single tenant."""

    organisation_id: str
    cpu_millicore_seconds: int
    ram_byte_seconds: int
    s3_storage_bytes: int
    s3_egress_bytes: int
    livekit_turn_relay_bytes: int
    active_seats: int
    tenant_revenue_excl_vat_minor: int

    def __post_init__(self) -> None:
        _validate_org_id(self.organisation_id)
        _require_non_negative_int(
            self.cpu_millicore_seconds, "cpu_millicore_seconds", code="negative_finops_metric"
        )
        _require_non_negative_int(
            self.ram_byte_seconds, "ram_byte_seconds", code="negative_finops_metric"
        )
        _require_non_negative_int(
            self.s3_storage_bytes, "s3_storage_bytes", code="negative_finops_metric"
        )
        _require_non_negative_int(
            self.s3_egress_bytes, "s3_egress_bytes", code="negative_finops_metric"
        )
        _require_non_negative_int(
            self.livekit_turn_relay_bytes,
            "livekit_turn_relay_bytes",
            code="negative_finops_metric",
        )
        _require_non_negative_int(self.active_seats, "active_seats", code="negative_finops_metric")
        _require_non_negative_int(
            self.tenant_revenue_excl_vat_minor,
            "tenant_revenue_excl_vat_minor",
            code="negative_amount",
        )


@dataclass(frozen=True, slots=True)
class TenantFinOpsAttribution:
    """Deterministic minor-unit COGS attribution and gross-margin evaluation for one tenant."""

    organisation_id: str
    cpu_millicore_seconds: int
    ram_byte_seconds: int
    s3_storage_bytes: int
    s3_egress_bytes: int
    livekit_turn_relay_bytes: int
    active_seats: int
    compute_attributed_minor: int
    s3_attributed_minor: int
    turn_livekit_attributed_minor: int
    shared_platform_attributed_minor: int
    total_attributed_minor: int
    tenant_revenue_excl_vat_minor: int
    gross_margin_minor: int
    gross_margin_bps: int
    below_margin_floor: bool


@dataclass(frozen=True, slots=True)
class FinOpsReconciliationReport:
    """Provider invoice reconciliation report across all metered tenants."""

    currency: str
    billing_period: str | None
    provider_invoice_ref: str | None
    provider_invoice_total_minor: int
    compute_pool_minor: int
    s3_pool_minor: int
    turn_livekit_pool_minor: int
    shared_platform_minor: int
    pools_subtotal_minor: int
    allocated_compute_minor: int
    allocated_s3_minor: int
    allocated_turn_livekit_minor: int
    allocated_shared_platform_minor: int
    allocated_total_minor: int
    pool_unallocated_minor: int
    unpooled_overhead_minor: int
    unallocated_remainder_minor: int
    total_tenant_revenue_excl_vat_minor: int
    fleet_gross_margin_bps: int
    min_gross_margin_bps: int
    flagged_organisation_ids: tuple[str, ...]
    tenants: tuple[TenantFinOpsAttribution, ...]

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["flagged_organisation_ids"] = list(self.flagged_organisation_ids)
        payload["tenants"] = [asdict(row) for row in self.tenants]
        return payload


def proportional_floor_allocate(
    pool_minor: int,
    tenant_usages: Sequence[int],
    *,
    pool_name: str = "pool_minor",
) -> tuple[tuple[int, ...], int]:
    """Allocate `pool_minor` via exact `(pool_minor * usage) // total_usage` floor division."""
    checked_pool = _require_non_negative_int(pool_minor, pool_name, code="negative_amount")
    checked_usages = tuple(
        _require_non_negative_int(u, f"{pool_name}_usage", code="negative_finops_metric")
        for u in tenant_usages
    )
    if not checked_usages or checked_pool == 0:
        return (0,) * len(checked_usages), checked_pool

    total_usage = sum(checked_usages)
    if total_usage == 0:
        return (0,) * len(checked_usages), checked_pool

    shares = tuple((checked_pool * usage) // total_usage for usage in checked_usages)
    allocated = sum(shares)
    if allocated < 0 or allocated > checked_pool:
        raise FinOpsValidationError(
            f"{pool_name} allocation exceeded pool subtotal",
            code="pool_subtotal_exceeded",
        )
    return shares, checked_pool - allocated


def verify_finops_report(report: FinOpsReconciliationReport) -> None:
    """Fail closed if any pool subtotal or provider invoice conservation invariant fails."""
    expected_pools_sum = (
        report.compute_pool_minor
        + report.s3_pool_minor
        + report.turn_livekit_pool_minor
        + report.shared_platform_minor
    )
    if report.pools_subtotal_minor != expected_pools_sum:
        raise FinOpsValidationError(
            "pools_subtotal_minor does not equal sum of resource pools",
            code="invoice_reconciliation_mismatch",
        )
    if report.provider_invoice_total_minor < report.pools_subtotal_minor:
        raise FinOpsValidationError(
            "provider_invoice_total_minor is less than sum of resource pools",
            code="invoice_below_pool_sum",
        )
    if (
        not (0 <= report.allocated_compute_minor <= report.compute_pool_minor)
        or not (0 <= report.allocated_s3_minor <= report.s3_pool_minor)
        or not (0 <= report.allocated_turn_livekit_minor <= report.turn_livekit_pool_minor)
        or not (0 <= report.allocated_shared_platform_minor <= report.shared_platform_minor)
    ):
        raise FinOpsValidationError(
            "allocated pool amount out of bounds",
            code="pool_subtotal_exceeded",
        )
    sum_tenant_totals = sum(t.total_attributed_minor for t in report.tenants)
    expected_allocated = (
        report.allocated_compute_minor
        + report.allocated_s3_minor
        + report.allocated_turn_livekit_minor
        + report.allocated_shared_platform_minor
    )
    if (
        report.allocated_total_minor != sum_tenant_totals
        or report.allocated_total_minor != expected_allocated
        or report.unallocated_remainder_minor < 0
        or report.allocated_total_minor + report.unallocated_remainder_minor
        != report.provider_invoice_total_minor
    ):
        raise FinOpsValidationError(
            "allocated_total_minor + unallocated_remainder_minor does not equal provider_invoice_total_minor",
            code="invoice_reconciliation_mismatch",
        )


def reconcile_finops_attribution(
    *,
    provider_invoice_total_minor: int,
    compute_pool_minor: int,
    s3_pool_minor: int,
    turn_livekit_pool_minor: int,
    shared_platform_minor: int,
    tenants: Sequence[TenantResourceUsage],
    currency: str = CURRENCY_EUR,
    billing_period: str | None = None,
    provider_invoice_ref: str | None = None,
    min_gross_margin_bps: int = MIN_GROSS_MARGIN_BPS,
    expected_unallocated_remainder_minor: int | None = None,
    cpu_millicore_weight: int = DEFAULT_CPU_MILLICORE_WEIGHT,
    ram_byte_weight: int = DEFAULT_RAM_BYTE_WEIGHT,
    s3_storage_weight: int = DEFAULT_S3_STORAGE_WEIGHT,
    s3_egress_weight: int = DEFAULT_S3_EGRESS_WEIGHT,
) -> FinOpsReconciliationReport:
    """Attribute infrastructure pools deterministically and reconcile to provider invoice total."""
    if not isinstance(currency, str) or currency != CURRENCY_EUR:
        raise FinOpsValidationError(
            "FinOps reconciliation requires currency EUR",
            code="unsupported_currency",
        )
    clean_period = _validate_optional_ascii_token(
        billing_period,
        field_name="billing_period",
        max_len=64,
        code="invalid_billing_period",
    )
    clean_invoice_ref = _validate_optional_ascii_token(
        provider_invoice_ref,
        field_name="provider_invoice_ref",
        max_len=128,
        code="invalid_provider_invoice_ref",
    )

    invoice_total = _require_non_negative_int(
        provider_invoice_total_minor, "provider_invoice_total_minor", code="negative_amount"
    )
    compute_pool = _require_non_negative_int(
        compute_pool_minor, "compute_pool_minor", code="negative_amount"
    )
    s3_pool = _require_non_negative_int(s3_pool_minor, "s3_pool_minor", code="negative_amount")
    turn_pool = _require_non_negative_int(
        turn_livekit_pool_minor, "turn_livekit_pool_minor", code="negative_amount"
    )
    shared_pool = _require_non_negative_int(
        shared_platform_minor, "shared_platform_minor", code="negative_amount"
    )
    floor_bps = require_strict_int(min_gross_margin_bps, "min_gross_margin_bps")
    if not 0 <= floor_bps <= BPS_DENOMINATOR:
        raise FinOpsValidationError(
            "min_gross_margin_bps must be between 0 and 10000",
            code="invalid_bps",
        )

    w_cpu = _require_positive_weight(cpu_millicore_weight, "cpu_millicore_weight")
    w_ram = _require_positive_weight(ram_byte_weight, "ram_byte_weight")
    w_s3_store = _require_positive_weight(s3_storage_weight, "s3_storage_weight")
    w_s3_egress = _require_positive_weight(s3_egress_weight, "s3_egress_weight")

    checked_expected_remainder: int | None = None
    if expected_unallocated_remainder_minor is not None:
        checked_expected_remainder = _require_non_negative_int(
            expected_unallocated_remainder_minor,
            "expected_unallocated_remainder_minor",
            code="negative_amount",
        )

    pools_subtotal = compute_pool + s3_pool + turn_pool + shared_pool
    if invoice_total < pools_subtotal:
        raise FinOpsValidationError(
            "provider_invoice_total_minor cannot be smaller than sum(pools)",
            code="invoice_below_pool_sum",
        )

    if isinstance(tenants, (str, bytes, Mapping)) or not isinstance(tenants, Sequence):
        raise FinOpsValidationError(
            "tenants must be a sequence of TenantResourceUsage records",
            code="invalid_tenants_payload",
        )
    if len(tenants) > MAX_FINOPS_TENANTS:
        raise FinOpsValidationError(
            f"tenants exceeds maximum batch size of {MAX_FINOPS_TENANTS}",
            code="invalid_tenants_payload",
        )

    seen_orgs: set[str] = set()
    validated_tenants: list[TenantResourceUsage] = []
    for item in tenants:
        if not isinstance(item, TenantResourceUsage):
            raise TypeError("each tenant entry must be a TenantResourceUsage instance")
        if item.organisation_id in seen_orgs:
            raise FinOpsValidationError(
                f"duplicate organisation_id in FinOps batch: {item.organisation_id}",
                code="duplicate_organisation_id",
            )
        seen_orgs.add(item.organisation_id)
        validated_tenants.append(item)

    ordered = sorted(validated_tenants, key=lambda row: row.organisation_id)

    compute_units = [
        row.cpu_millicore_seconds * w_cpu + row.ram_byte_seconds * w_ram for row in ordered
    ]
    s3_units = [
        row.s3_storage_bytes * w_s3_store + row.s3_egress_bytes * w_s3_egress for row in ordered
    ]
    turn_units = [row.livekit_turn_relay_bytes for row in ordered]
    seat_units = [row.active_seats for row in ordered]

    compute_shares, compute_rem = proportional_floor_allocate(
        compute_pool, compute_units, pool_name="compute_pool_minor"
    )
    s3_shares, s3_rem = proportional_floor_allocate(s3_pool, s3_units, pool_name="s3_pool_minor")
    turn_shares, turn_rem = proportional_floor_allocate(
        turn_pool, turn_units, pool_name="turn_livekit_pool_minor"
    )
    shared_shares, shared_rem = proportional_floor_allocate(
        shared_pool, seat_units, pool_name="shared_platform_minor"
    )

    attributed_rows: list[TenantFinOpsAttribution] = []
    flagged_orgs: list[str] = []
    for idx, tenant in enumerate(ordered):
        c_minor = compute_shares[idx]
        s_minor = s3_shares[idx]
        t_minor = turn_shares[idx]
        p_minor = shared_shares[idx]
        total_minor = c_minor + s_minor + t_minor + p_minor
        rev_minor = tenant.tenant_revenue_excl_vat_minor
        margin_minor = rev_minor - total_minor
        margin_bps = compute_gross_margin_bps(rev_minor, total_minor)
        below_floor = rev_minor <= 0 or margin_bps < floor_bps
        if below_floor:
            flagged_orgs.append(tenant.organisation_id)
        attributed_rows.append(
            TenantFinOpsAttribution(
                organisation_id=tenant.organisation_id,
                cpu_millicore_seconds=tenant.cpu_millicore_seconds,
                ram_byte_seconds=tenant.ram_byte_seconds,
                s3_storage_bytes=tenant.s3_storage_bytes,
                s3_egress_bytes=tenant.s3_egress_bytes,
                livekit_turn_relay_bytes=tenant.livekit_turn_relay_bytes,
                active_seats=tenant.active_seats,
                compute_attributed_minor=c_minor,
                s3_attributed_minor=s_minor,
                turn_livekit_attributed_minor=t_minor,
                shared_platform_attributed_minor=p_minor,
                total_attributed_minor=total_minor,
                tenant_revenue_excl_vat_minor=rev_minor,
                gross_margin_minor=margin_minor,
                gross_margin_bps=margin_bps,
                below_margin_floor=below_floor,
            )
        )

    allocated_compute = sum(compute_shares)
    allocated_s3 = sum(s3_shares)
    allocated_turn = sum(turn_shares)
    allocated_shared = sum(shared_shares)
    allocated_total = sum(row.total_attributed_minor for row in attributed_rows)
    pool_unallocated = compute_rem + s3_rem + turn_rem + shared_rem
    unpooled_overhead = invoice_total - pools_subtotal
    computed_remainder = invoice_total - allocated_total

    effective_remainder = (
        checked_expected_remainder if checked_expected_remainder is not None else computed_remainder
    )
    total_revenue = sum(row.tenant_revenue_excl_vat_minor for row in attributed_rows)
    fleet_margin_bps = compute_gross_margin_bps(total_revenue, invoice_total)

    report = FinOpsReconciliationReport(
        currency=CURRENCY_EUR,
        billing_period=clean_period,
        provider_invoice_ref=clean_invoice_ref,
        provider_invoice_total_minor=invoice_total,
        compute_pool_minor=compute_pool,
        s3_pool_minor=s3_pool,
        turn_livekit_pool_minor=turn_pool,
        shared_platform_minor=shared_pool,
        pools_subtotal_minor=pools_subtotal,
        allocated_compute_minor=allocated_compute,
        allocated_s3_minor=allocated_s3,
        allocated_turn_livekit_minor=allocated_turn,
        allocated_shared_platform_minor=allocated_shared,
        allocated_total_minor=allocated_total,
        pool_unallocated_minor=pool_unallocated,
        unpooled_overhead_minor=unpooled_overhead,
        unallocated_remainder_minor=effective_remainder,
        total_tenant_revenue_excl_vat_minor=total_revenue,
        fleet_gross_margin_bps=fleet_margin_bps,
        min_gross_margin_bps=floor_bps,
        flagged_organisation_ids=tuple(flagged_orgs),
        tenants=tuple(attributed_rows),
    )
    verify_finops_report(report)
    return report


def parse_tenant_usage(entry: object) -> TenantResourceUsage:
    """Parse and strictly validate one JSON tenant usage mapping."""
    if not isinstance(entry, Mapping):
        raise FinOpsValidationError(
            "each tenant entry must be a JSON object",
            code="invalid_tenants_payload",
        )
    return TenantResourceUsage(
        organisation_id=entry.get("organisation_id"),  # type: ignore[arg-type]
        cpu_millicore_seconds=entry.get("cpu_millicore_seconds"),  # type: ignore[arg-type]
        ram_byte_seconds=entry.get("ram_byte_seconds"),  # type: ignore[arg-type]
        s3_storage_bytes=entry.get("s3_storage_bytes"),  # type: ignore[arg-type]
        s3_egress_bytes=entry.get("s3_egress_bytes"),  # type: ignore[arg-type]
        livekit_turn_relay_bytes=entry.get("livekit_turn_relay_bytes"),  # type: ignore[arg-type]
        active_seats=entry.get("active_seats"),  # type: ignore[arg-type]
        tenant_revenue_excl_vat_minor=entry.get("tenant_revenue_excl_vat_minor"),  # type: ignore[arg-type]
    )


def reconcile_finops_payload(data: Mapping[str, Any]) -> FinOpsReconciliationReport:
    """Parse an untrusted JSON mapping and execute strict FinOps attribution reconciliation."""
    if not isinstance(data, Mapping):
        raise FinOpsValidationError(
            "FinOps payload must be a JSON object",
            code="finops_validation_error",
        )
    raw_tenants = data.get("tenants")
    if isinstance(raw_tenants, (str, bytes, Mapping)) or not isinstance(raw_tenants, Sequence):
        raise FinOpsValidationError(
            "tenants must be a JSON array",
            code="invalid_tenants_payload",
        )
    if len(raw_tenants) > MAX_FINOPS_TENANTS:
        raise FinOpsValidationError(
            f"tenants exceeds maximum batch size of {MAX_FINOPS_TENANTS}",
            code="invalid_tenants_payload",
        )
    parsed_tenants = [parse_tenant_usage(item) for item in raw_tenants]

    kwargs: dict[str, Any] = {
        "provider_invoice_total_minor": data.get("provider_invoice_total_minor"),
        "compute_pool_minor": data.get("compute_pool_minor"),
        "s3_pool_minor": data.get("s3_pool_minor"),
        "turn_livekit_pool_minor": data.get("turn_livekit_pool_minor"),
        "shared_platform_minor": data.get("shared_platform_minor"),
        "tenants": parsed_tenants,
        "currency": data.get("currency", CURRENCY_EUR),
        "billing_period": data.get("billing_period"),
        "provider_invoice_ref": data.get("provider_invoice_ref"),
        "expected_unallocated_remainder_minor": data.get("expected_unallocated_remainder_minor"),
    }
    if "min_gross_margin_bps" in data and data["min_gross_margin_bps"] is not None:
        kwargs["min_gross_margin_bps"] = data["min_gross_margin_bps"]
    if "cpu_millicore_weight" in data and data["cpu_millicore_weight"] is not None:
        kwargs["cpu_millicore_weight"] = data["cpu_millicore_weight"]
    if "ram_byte_weight" in data and data["ram_byte_weight"] is not None:
        kwargs["ram_byte_weight"] = data["ram_byte_weight"]
    if "s3_storage_weight" in data and data["s3_storage_weight"] is not None:
        kwargs["s3_storage_weight"] = data["s3_storage_weight"]
    if "s3_egress_weight" in data and data["s3_egress_weight"] is not None:
        kwargs["s3_egress_weight"] = data["s3_egress_weight"]

    return reconcile_finops_attribution(**kwargs)
