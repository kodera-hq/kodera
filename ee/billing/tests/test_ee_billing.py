# SPDX-License-Identifier: LicenseRef-Kodera-EE
# ruff: noqa: S101
"""Unit, security RBAC, CodeQL hygiene, and PostgreSQL durability tests for `ee/billing/`."""

from __future__ import annotations

import ast
import json
import uuid
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

import pytest

from ee.billing import (
    EnterpriseEditionRequiredError,
    is_enterprise_edition,
    require_enterprise_edition,
)
from ee.billing.api import (
    BillingForbiddenError,
    BillingPrincipal,
    BillingUnauthenticatedError,
    EnterpriseBillingRouter,
)
from ee.billing.pricing import (
    MIN_GROSS_MARGIN_BPS,
    SOVEREIGN_BASE_ANNUAL_CENTS,
    SOVEREIGN_BASE_MONTHLY_CENTS,
    SOVEREIGN_INCLUDED_SEATS,
    TEAM_ANNUAL_SEAT_MONTHLY_CENTS,
    TEAM_ANNUAL_SEAT_YEARLY_CENTS,
    TEAM_MONTHLY_SEAT_CENTS,
    MarginFloorViolationError,
    PlanQuote,
    PricingValidationError,
    commercial_schedule_summary,
    compute_gross_margin_bps,
    compute_vat_minor,
    enforce_margin_floor,
    list_price_excl_vat_minor,
    quote_plan,
    require_strict_int,
    select_sovereign_infra_tier,
)
from ee.billing.purchase_orders import (
    CommitmentExceededError,
    InvalidPurchaseOrderTransitionError,
    PurchaseOrderBook,
    PurchaseOrderForbiddenError,
    PurchaseOrderNotFoundError,
    PurchaseOrderValidationError,
    validate_invoice_reference,
)
from ee.billing.warm_pool import (
    SOVEREIGN_POOL_WATERMARKS,
    PoolWatermarks,
    WarmPoolController,
    WarmPoolExhaustedError,
    WarmPoolIdempotencyConflictError,
    WarmPoolTransitionError,
    WarmPoolValidationError,
)


def _staff_test_auth(headers: Mapping[str, str]) -> BillingPrincipal:
    auth = headers.get("authorization", "")
    if auth == "Bearer test-staff":
        return BillingPrincipal(
            lane="staff",
            identity_id="staff-1",
            staff_roles=frozenset({"staff_operator"}),
        )
    if auth == "Bearer test-owner-acme":
        return BillingPrincipal(
            lane="customer",
            identity_id="cust-owner-1",
            org_roles={"org_acme": "org_owner"},
        )
    if auth == "Bearer test-admin-acme":
        return BillingPrincipal(
            lane="customer",
            identity_id="cust-admin-1",
            org_roles={"org_acme": "org_admin"},
        )
    if auth == "Bearer test-member-acme":
        return BillingPrincipal(
            lane="customer",
            identity_id="cust-member-1",
            org_roles={"org_acme": "org_member"},
        )
    if auth == "Bearer test-disabled":
        raise BillingForbiddenError()
    raise BillingUnauthenticatedError()


class TestCodeQLStaticGuards:
    """Guarantee zero `import re` and zero `str(exc)` response serialization across `ee/billing/`."""

    def test_zero_regex_imports_and_zero_exception_stringification_in_api(self) -> None:
        billing_dir = Path(__file__).resolve().parents[1]
        py_files = sorted(p for p in billing_dir.glob("*.py") if p.is_file())
        assert {p.name for p in py_files} >= {
            "__init__.py",
            "api.py",
            "pricing.py",
            "purchase_orders.py",
            "storage.py",
            "urls.py",
            "warm_pool.py",
        }
        for py_file in py_files:
            tree = ast.parse(py_file.read_text(encoding="utf-8"), filename=str(py_file))
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    imported = {alias.name for alias in node.names}
                    assert "re" not in imported, f"{py_file.name} imports re"
                elif isinstance(node, ast.ImportFrom):
                    assert node.module != "re", f"{py_file.name} imports from re"
                elif isinstance(node, ast.ExceptHandler) and node.name:
                    exc_name = node.name
                    for inner in ast.walk(node):
                        if (
                            isinstance(inner, ast.Call)
                            and isinstance(inner.func, ast.Name)
                            and inner.func.id in ("str", "repr")
                            and any(
                                isinstance(arg, ast.Name) and arg.id == exc_name
                                for arg in inner.args
                            )
                        ):
                            pytest.fail(
                                f"{py_file.name} passes str/repr({exc_name}) in except handler"
                            )


class TestEditionGuard:
    def test_defaults_to_community_and_normalizes_case_and_whitespace(self) -> None:
        assert is_enterprise_edition({}) is False
        assert is_enterprise_edition({"KODERA_EDITION": "community"}) is False
        assert is_enterprise_edition({"KODERA_EDITION": "  Enterprise \n"}) is True
        assert is_enterprise_edition({"KODERA_EDITION": "ee"}) is False

    def test_require_enterprise_edition_refuses_community(self) -> None:
        with pytest.raises(EnterpriseEditionRequiredError):
            require_enterprise_edition({"KODERA_EDITION": "community"})
        require_enterprise_edition({"KODERA_EDITION": "enterprise"})


class TestCommercialPricing:
    def test_canonical_list_prices_in_minor_units(self) -> None:
        assert TEAM_ANNUAL_SEAT_MONTHLY_CENTS == 500
        assert TEAM_ANNUAL_SEAT_YEARLY_CENTS == 6_000
        assert TEAM_MONTHLY_SEAT_CENTS == 600
        assert SOVEREIGN_BASE_MONTHLY_CENTS == 29_000
        assert SOVEREIGN_BASE_ANNUAL_CENTS == 348_000
        assert SOVEREIGN_INCLUDED_SEATS == 25
        assert MIN_GROSS_MARGIN_BPS == 4_400

    def test_team_monthly_and_annual_seat_quotes(self) -> None:
        annual = quote_plan("team", seats=10, billing_cycle="annual", vat_rate_bps=2_000)
        assert annual.list_excl_vat_minor == 60_000
        assert annual.net_excl_vat_minor == 60_000
        assert annual.vat_amount_minor == 12_000
        assert annual.total_incl_vat_minor == 72_000
        assert annual.gross_margin_bps >= MIN_GROSS_MARGIN_BPS

        monthly = quote_plan("team", seats=10, billing_cycle="monthly", vat_rate_bps=2_000)
        assert monthly.list_excl_vat_minor == 6_000
        assert monthly.vat_amount_minor == 1_200
        assert monthly.total_incl_vat_minor == 7_200
        assert monthly.gross_margin_bps >= MIN_GROSS_MARGIN_BPS

    def test_sovereign_base_and_tiered_seat_overages(self) -> None:
        base_quote = quote_plan("sovereign", seats=25, billing_cycle="monthly")
        assert isinstance(base_quote, PlanQuote)
        assert base_quote.list_excl_vat_minor == 29_000
        assert base_quote.estimated_cogs_minor == 6_900
        assert base_quote.gross_margin_bps == 7_620
        assert base_quote.vm_shape == "PRO2-S"
        assert select_sovereign_infra_tier(1).code == "PRO2-S"
        assert select_sovereign_infra_tier(25).code == "PRO2-S"

        tier_m_edge = quote_plan("sovereign", seats=26, billing_cycle="monthly")
        assert tier_m_edge.vm_shape == "PRO2-M"
        assert tier_m_edge.estimated_cogs_minor == 10_990
        assert tier_m_edge.gross_margin_bps >= MIN_GROSS_MARGIN_BPS
        assert select_sovereign_infra_tier(100).code == "PRO2-M"

        tier1 = quote_plan("sovereign", seats=30, billing_cycle="monthly")
        assert tier1.list_excl_vat_minor == 33_000
        assert tier1.vm_shape == "PRO2-M"
        assert tier1.gross_margin_bps >= MIN_GROSS_MARGIN_BPS

        tier_l = quote_plan("sovereign", seats=101, billing_cycle="monthly")
        assert tier_l.vm_shape == "PRO2-L"
        assert select_sovereign_infra_tier(101).code == "PRO2-L"
        assert tier_l.gross_margin_bps >= MIN_GROSS_MARGIN_BPS

        tier2 = list_price_excl_vat_minor("sovereign", seats=120, billing_cycle="monthly")
        assert tier2 == 101_000
        assert SOVEREIGN_POOL_WATERMARKS == PoolWatermarks(min_ready=1, target_ready=2, max_total=3)

    def test_strict_integer_guard_rejects_floats_bools_and_decimals(self) -> None:
        for bad in (5.0, True, False, Decimal("5"), "5"):
            with pytest.raises(TypeError):
                require_strict_int(bad, "amount")
            with pytest.raises(TypeError):
                quote_plan("team", seats=bad)  # type: ignore[arg-type]

        with pytest.raises(TypeError):
            compute_vat_minor(1000.0, 2000)  # type: ignore[arg-type]

    def test_gross_margin_floor_guard_refuses_below_4400_bps_and_allows_exact_boundary(
        self,
    ) -> None:
        with pytest.raises(MarginFloorViolationError) as exc_info:
            enforce_margin_floor(10_000, 5_601)
        assert exc_info.value.actual_bps == 4_399
        assert exc_info.value.required_bps == 4_400
        assert exc_info.value.code == "margin_floor_violation"

        assert enforce_margin_floor(10_000, 5_600) == 4_400
        assert compute_gross_margin_bps(10_000, 5_600) == 4_400

        with pytest.raises(MarginFloorViolationError):
            quote_plan("team", seats=20, billing_cycle="monthly", discount_bps=7_000)

    def test_community_plan_and_schedule_summary(self) -> None:
        community = quote_plan("community", seats=5, vat_rate_bps=2_000)
        assert community.total_incl_vat_minor == 0
        with pytest.raises(PricingValidationError) as exc_info:
            quote_plan("community", seats=5, custom_net_excl_vat_minor=100)
        assert exc_info.value.code == "community_nonzero_charge"

        summary = commercial_schedule_summary()
        assert summary["currency"] == "EUR"
        assert summary["min_gross_margin_bps"] == 4_400
        raw_plans = summary["plans"]
        assert isinstance(raw_plans, list)
        plans = {p["code"]: p for p in raw_plans}
        assert plans["team"]["annual_monthly_equivalent_minor"] == 500
        assert plans["team"]["monthly_unit_minor"] == 600
        assert plans["sovereign"]["base_monthly_minor"] == 29_000


class TestWarmPoolController:
    def test_watermark_validation(self) -> None:
        with pytest.raises(WarmPoolValidationError):
            PoolWatermarks(min_ready=-1, target_ready=2, max_total=4)
        with pytest.raises(WarmPoolValidationError):
            PoolWatermarks(min_ready=5, target_ready=4, max_total=8)
        with pytest.raises(WarmPoolValidationError):
            PoolWatermarks(min_ready=2, target_ready=6, max_total=5)
        with pytest.raises(TypeError):
            PoolWatermarks(min_ready=2.0, target_ready=4, max_total=8)  # type: ignore[arg-type]

    def test_replenish_ready_claim_idempotency_and_unhealthy_eviction(self) -> None:
        pool = WarmPoolController(
            PoolWatermarks(min_ready=2, target_ready=3, max_total=4),
            backend="memory",
        )
        initial = pool.sizing_snapshot()
        assert initial.below_low_watermark is True
        assert initial.replenish_needed == 3

        created = pool.replenish()
        assert len(created) == 3
        for slot in created:
            pool.mark_ready(slot.slot_id)

        ready_snap = pool.sizing_snapshot()
        assert ready_snap.ready_count == 3
        assert ready_snap.below_low_watermark is False
        assert ready_snap.replenish_needed == 0

        pool.mark_unhealthy(created[0].slot_id, reason="livekit-probe-timeout")
        claim1 = pool.claim_slot(
            idempotency_key="idem-checkout-0001",
            organisation_id="org_alpha",
            checkout_id="cs_live_0001",
        )
        assert claim1.replayed is False
        assert claim1.slot.slot_id == created[1].slot_id
        assert claim1.below_low_watermark is True

        replay = pool.claim_slot(
            idempotency_key="idem-checkout-0001",
            organisation_id="org_alpha",
            checkout_id="cs_live_0001",
        )
        assert replay.replayed is True
        assert replay.slot.slot_id == created[1].slot_id
        assert pool.sizing_snapshot().ready_count == 1

        # Cross-tenant reuse of same Idempotency-Key (`E02-003` / `BUG-0057`) is isolated:
        claim_beta = pool.claim_slot(
            idempotency_key="idem-checkout-0001",
            organisation_id="org_beta",
            checkout_id="cs_live_9999",
        )
        assert claim_beta.replayed is False
        assert claim_beta.slot.slot_id == created[2].slot_id

        # Same-tenant reuse with mismatched checkout_id raises conflict:
        with pytest.raises(WarmPoolIdempotencyConflictError):
            pool.claim_slot(
                idempotency_key="idem-checkout-0001",
                organisation_id="org_alpha",
                checkout_id="cs_live_9999",
            )

        evicted = pool.evict_unhealthy()
        assert [s.slot_id for s in evicted] == [created[0].slot_id]
        replenished = pool.replenish()
        assert len(replenished) == 3

        with pytest.raises(WarmPoolTransitionError):
            pool.mark_ready(claim1.slot.slot_id)

    def test_exhausted_pool_and_concurrent_claims_never_double_allocate(self) -> None:
        pool = WarmPoolController(
            PoolWatermarks(min_ready=1, target_ready=8, max_total=8),
            backend="memory",
        )
        with pytest.raises(WarmPoolExhaustedError) as exc_info:
            pool.claim_slot(
                idempotency_key="idem-empty-0001",
                organisation_id="org_empty",
                checkout_id="cs_empty",
            )
        assert exc_info.value.replenish_count == 8

        slots = pool.replenish()
        for s in slots:
            pool.mark_ready(s.slot_id)

        def worker(idx: int) -> str:
            res = pool.claim_slot(
                idempotency_key=f"idem-concurrent-{idx:04d}",
                organisation_id=f"org_{idx:04d}",
                checkout_id=f"cs_{idx:04d}",
            )
            return res.slot.slot_id

        with ThreadPoolExecutor(max_workers=8) as executor:
            claimed_ids = list(executor.map(worker, range(8)))

        assert len(claimed_ids) == 8
        assert len(set(claimed_ids)) == 8


class TestPurchaseOrders:
    def test_full_po_lifecycle_commitments_and_invoice_validation(self) -> None:
        env = {"KODERA_EDITION": "enterprise"}
        book = PurchaseOrderBook(backend="memory")
        t0 = datetime(2026, 11, 14, 12, 0, tzinfo=UTC)
        po = book.create_draft(
            organisation_id="org_ministry_01",
            customer_po_reference="BDC-2026-8841",
            plan_code="sovereign",
            billing_months=12,
            committed_seats=100,
            committed_storage_gb=500,
            subtotal_excl_vat_minor=900_000,
            created_at=t0,
            expires_at=t0 + timedelta(days=30),
            environ=env,
        )
        assert po.state == "draft"
        assert po.vat_amount_minor == 180_000
        assert po.total_incl_vat_minor == 1_080_000

        with pytest.raises(InvalidPurchaseOrderTransitionError):
            book.evaluate_commitment(po.po_id, active_seats=10, used_storage_gb=10, environ=env)
        with pytest.raises(PurchaseOrderForbiddenError):
            book.bind_invoice(po.po_id, invoice_ref="INV-KODERA-2026-00001", environ=env)
        with pytest.raises(InvalidPurchaseOrderTransitionError):
            book.bind_invoice(
                po.po_id,
                invoice_ref="INV-KODERA-2026-00001",
                actor_lane="staff",
                environ=env,
            )

        po = book.issue(po.po_id, at=t0 + timedelta(hours=1), environ=env)
        assert po.state == "issued"

        po = book.countersign(
            po.po_id,
            signatory="Direction des Achats",
            at=t0 + timedelta(hours=2),
            environ=env,
        )
        assert po.state == "countersigned"

        ok_eval = book.evaluate_commitment(
            po.po_id, active_seats=100, used_storage_gb=500, environ=env
        )
        assert ok_eval.within_commitment is True

        with pytest.raises(CommitmentExceededError):
            book.evaluate_commitment(po.po_id, active_seats=101, used_storage_gb=500, environ=env)

        soft_eval = book.evaluate_commitment(
            po.po_id,
            active_seats=105,
            used_storage_gb=520,
            enforce_hard_cap=False,
            environ=env,
        )
        assert soft_eval.within_commitment is False
        assert soft_eval.seat_overage == 5
        assert soft_eval.storage_overage_gb == 20

        assert validate_invoice_reference("INV-SAM-FR-2026-00001") == "INV-SAM-FR-2026-00001"
        for bad_ref in (
            "bad-ref-123",
            "FAC-2026-00001",
            "INV-k-2026-00001",
            "INV-KODERA-26-00001",
            "INV-KODERA-2026-0042",
            "INV-A-B-C-2026-00001",
        ):
            with pytest.raises(PurchaseOrderValidationError):
                validate_invoice_reference(bad_ref)
        with pytest.raises(PurchaseOrderValidationError):
            book.bind_invoice(po.po_id, invoice_ref="FAC-2026-01", actor_lane="staff", environ=env)
        with pytest.raises(PurchaseOrderForbiddenError):
            book.bind_invoice(po.po_id, invoice_ref="INV-KODERA-2026-00042", environ=env)
        with pytest.raises(PurchaseOrderValidationError) as unverified_inv:
            book.bind_invoice(
                po.po_id,
                invoice_ref="INV-KODERA-2026-00042",
                actor_lane="staff",
                environ=env,
            )
        assert unverified_inv.value.code == "unverified_core_invoice"

        book.register_core_invoice(
            "INV-KODERA-2026-00042",
            organisation_id="org_ministry_01",
            total_incl_vat_minor=1_080_000,
            state="issued",
        )
        po = book.bind_invoice(
            po.po_id,
            invoice_ref="INV-KODERA-2026-00042",
            actor_lane="staff",
            at=t0 + timedelta(days=1),
            environ=env,
        )
        assert po.state == "invoiced"

        with pytest.raises(PurchaseOrderForbiddenError):
            book.mark_paid(
                po.po_id,
                invoice_ref="INV-KODERA-2026-00042",
                payment_ref="SEPA-WIRE-001",
                amount_paid_minor=1_080_000,
                environ=env,
            )
        with pytest.raises(PurchaseOrderValidationError):
            book.mark_paid(
                po.po_id,
                invoice_ref="INV-KODERA-2026-00042",
                payment_ref="SEPA-WIRE-001",
                amount_paid_minor=900_000,
                actor_lane="staff",
                environ=env,
            )
        with pytest.raises(PurchaseOrderValidationError) as unverified_pay:
            book.mark_paid(
                po.po_id,
                invoice_ref="INV-KODERA-2026-00042",
                payment_ref="SEPA-WIRE-001",
                amount_paid_minor=1_080_000,
                actor_lane="staff",
                environ=env,
            )
        assert unverified_pay.value.code == "unverified_core_payment"

        book.register_core_payment(
            "INV-KODERA-2026-00042",
            "SEPA-WIRE-001",
            organisation_id="org_ministry_01",
            amount_minor=1_080_000,
            mark_invoice_paid=True,
        )
        po = book.mark_paid(
            po.po_id,
            invoice_ref="INV-KODERA-2026-00042",
            payment_ref="SEPA-WIRE-001",
            amount_paid_minor=1_080_000,
            actor_lane="staff",
            at=t0 + timedelta(days=5),
            environ=env,
        )
        assert po.state == "paid"

        with pytest.raises(InvalidPurchaseOrderTransitionError):
            book.expire(po.po_id, environ=env)

    def test_duplicate_invoice_ref_and_expiry_and_edition_guard(self) -> None:
        env = {"KODERA_EDITION": "enterprise"}
        book = PurchaseOrderBook(backend="memory")
        t0 = datetime(2026, 11, 14, 12, 0, tzinfo=UTC)

        with pytest.raises(EnterpriseEditionRequiredError):
            book.create_draft(
                organisation_id="org_01",
                customer_po_reference="PO-CUST-1",
                committed_seats=25,
                committed_storage_gb=100,
                subtotal_excl_vat_minor=400_000,
                created_at=t0,
                expires_at=t0 + timedelta(days=10),
                environ={"KODERA_EDITION": "community"},
            )

        po1 = book.create_draft(
            organisation_id="org_01",
            customer_po_reference="PO-CUST-1",
            committed_seats=25,
            committed_storage_gb=100,
            subtotal_excl_vat_minor=400_000,
            created_at=t0,
            expires_at=t0 + timedelta(days=10),
            environ=env,
        )
        po2 = book.create_draft(
            organisation_id="org_02",
            customer_po_reference="PO-CUST-2",
            committed_seats=25,
            committed_storage_gb=100,
            subtotal_excl_vat_minor=400_000,
            created_at=t0,
            expires_at=t0 + timedelta(days=10),
            environ=env,
        )
        book.register_core_invoice(
            "INV-KODERA-2026-00100",
            organisation_id="org_01",
            total_incl_vat_minor=480_000,
        )
        book.issue(po1.po_id, at=t0 + timedelta(hours=1), environ=env)
        book.countersign(po1.po_id, signatory="CFO", at=t0 + timedelta(hours=2), environ=env)
        book.bind_invoice(
            po1.po_id,
            invoice_ref="INV-KODERA-2026-00100",
            actor_lane="staff",
            environ=env,
        )

        book.issue(po2.po_id, at=t0 + timedelta(hours=1), environ=env)
        book.countersign(po2.po_id, signatory="CFO", at=t0 + timedelta(hours=2), environ=env)
        with pytest.raises(PurchaseOrderValidationError):
            book.bind_invoice(
                po2.po_id,
                invoice_ref="INV-KODERA-2026-00100",
                actor_lane="staff",
                environ=env,
            )

        po3 = book.create_draft(
            organisation_id="org_03",
            customer_po_reference="PO-CUST-3",
            committed_seats=25,
            committed_storage_gb=100,
            subtotal_excl_vat_minor=400_000,
            created_at=t0,
            expires_at=t0 + timedelta(days=2),
            environ=env,
        )
        with pytest.raises(InvalidPurchaseOrderTransitionError):
            book.issue(po3.po_id, at=t0 + timedelta(days=3), environ=env)
        assert book.get(po3.po_id, environ=env).state == "expired"

        with pytest.raises(PurchaseOrderNotFoundError):
            book.get("po_missing", environ=env)


class TestEnterpriseBillingHttpRouter:
    @pytest.mark.parametrize(
        ("method", "path"),
        [
            ("GET", "/api/v1/ee/billing/plans"),
            ("POST", "/api/v1/ee/billing/quotes"),
            ("GET", "/api/v1/ee/billing/warm-pool"),
            ("POST", "/api/v1/ee/billing/warm-pool/replenish"),
            ("POST", "/api/v1/ee/billing/warm-pool/evict"),
            ("POST", "/api/v1/ee/billing/warm-pool/claim"),
            ("POST", "/api/v1/ee/billing/purchase-orders"),
            ("GET", "/api/v1/ee/billing/purchase-orders/po_2026_00001"),
            ("POST", "/api/v1/ee/billing/purchase-orders/po_2026_00001/transitions"),
            ("POST", "/api/v1/ee/billing/purchase-orders/po_2026_00001/commitment-check"),
        ],
    )
    def test_community_mode_returns_404_on_every_route(self, method: str, path: str) -> None:
        router = EnterpriseBillingRouter(backend="memory", authenticator=_staff_test_auth)
        for env in ({}, {"KODERA_EDITION": "community"}, {"KODERA_EDITION": "self-host"}):
            resp = router.dispatch(method, path, environ=env)
            assert resp.status_code == 404
            assert resp.content_type == "application/problem+json"
            assert resp.json()["status"] == 404

    def test_enterprise_mode_serves_plans_quotes_warm_pool_and_pos_with_static_problem_details(
        self,
    ) -> None:
        env = {"KODERA_EDITION": "enterprise"}
        router = EnterpriseBillingRouter(backend="memory", authenticator=_staff_test_auth)
        staff_hdr = {"Authorization": "Bearer test-staff"}

        anon_resp = router.dispatch("GET", "/api/v1/ee/billing/plans", environ=env)
        assert anon_resp.status_code == 401
        assert anon_resp.headers["WWW-Authenticate"] == "Bearer"

        plans_resp = router.dispatch(
            "GET", "/api/v1/ee/billing/plans", headers=staff_hdr, environ=env
        )
        assert plans_resp.status_code == 200
        assert plans_resp.json()["min_gross_margin_bps"] == 4_400

        quote_resp = router.dispatch(
            "POST",
            "/api/v1/ee/billing/quotes",
            body=json.dumps({"plan_code": "team", "seats": 12, "billing_cycle": "annual"}).encode(),
            headers=staff_hdr,
            environ=env,
        )
        assert quote_resp.status_code == 200
        assert quote_resp.json()["net_excl_vat_minor"] == 72_000
        assert quote_resp.json()["vm_shape"] is None

        sov_quote_resp = router.dispatch(
            "POST",
            "/api/v1/ee/billing/quotes",
            body=json.dumps(
                {"plan_code": "sovereign", "seats": 25, "billing_cycle": "monthly"}
            ).encode(),
            headers=staff_hdr,
            environ=env,
        )
        assert sov_quote_resp.status_code == 200
        assert sov_quote_resp.json()["vm_shape"] == "PRO2-S"
        assert sov_quote_resp.json()["gross_margin_bps"] == 7_620

        bad_margin_resp = router.dispatch(
            "POST",
            "/api/v1/ee/billing/quotes",
            body=json.dumps(
                {
                    "plan_code": "team",
                    "seats": 12,
                    "billing_cycle": "monthly",
                    "discount_bps": 8_000,
                }
            ).encode(),
            headers=staff_hdr,
            environ=env,
        )
        assert bad_margin_resp.status_code == 422
        assert (
            bad_margin_resp.json()["detail"]
            == "Commercial quote falls below the minimum 44.0% gross-margin floor."
        )

        bad_type_resp = router.dispatch(
            "POST",
            "/api/v1/ee/billing/quotes",
            body=json.dumps({"plan_code": "team", "seats": "twelve"}).encode(),
            headers=staff_hdr,
            environ=env,
        )
        assert bad_type_resp.status_code == 422
        assert bad_type_resp.json()["detail"] == "A field has an invalid JSON value type."

        rep_resp = router.dispatch(
            "POST", "/api/v1/ee/billing/warm-pool/replenish", headers=staff_hdr, environ=env
        )
        assert rep_resp.status_code == 200
        first_slot_id = rep_resp.json()["created_slots"][0]["slot_id"]
        router.warm_pool.mark_ready(first_slot_id)

        po_create = router.dispatch(
            "POST",
            "/api/v1/ee/billing/purchase-orders",
            body=json.dumps(
                {
                    "organisation_id": "org_acme",
                    "customer_po_reference": "PO-ACME-2026-09",
                    "plan_code": "sovereign",
                    "billing_months": 12,
                    "committed_seats": 50,
                    "committed_storage_gb": 250,
                    "subtotal_excl_vat_minor": 600_000,
                }
            ).encode(),
            headers=staff_hdr,
            environ=env,
        )
        assert po_create.status_code == 201
        po_id = po_create.json()["po_id"]

        for step_hdr, payload in (
            (staff_hdr, {"action": "issue"}),
            (
                {"Authorization": "Bearer test-owner-acme"},
                {"action": "countersign", "signatory": "VP Finance"},
            ),
        ):
            step = router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
                body=json.dumps(payload).encode(),
                headers=step_hdr,
                environ=env,
            )
            assert step.status_code == 200

        claim_body = json.dumps({"organisation_id": "org_acme", "checkout_id": po_id}).encode()
        # Unpaid `countersigned` PO MUST NOT unlock warm-pool claim (`403`, `BUG-0057`)
        assert (
            router.dispatch(
                "POST",
                "/api/v1/ee/billing/warm-pool/claim",
                body=claim_body,
                headers={
                    "Authorization": "Bearer test-owner-acme",
                    "Idempotency-Key": "idem-http-unpaid-cs",
                },
                environ=env,
            ).status_code
            == 403
        )

        # Customer `org_owner` MUST be refused (403) on `invoice` and `pay` settlement actions
        assert (
            router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
                body=json.dumps(
                    {"action": "invoice", "invoice_ref": "INV-KODERA-2026-00777"}
                ).encode(),
                headers={"Authorization": "Bearer test-owner-acme"},
                environ=env,
            ).status_code
            == 403
        )

        # Operator (`staff`) with verified Core invoice + settled payment completes `invoice` -> `pay`
        router.purchase_orders.register_core_invoice(
            "INV-KODERA-2026-00777",
            organisation_id="org_acme",
            total_incl_vat_minor=720_000,
        )
        inv_step = router.dispatch(
            "POST",
            f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
            body=json.dumps({"action": "invoice", "invoice_ref": "INV-KODERA-2026-00777"}).encode(),
            headers=staff_hdr,
            environ=env,
        )
        assert inv_step.status_code == 200

        # Unpaid `invoiced` PO MUST ALSO NOT unlock warm-pool claim (`403`, `BUG-0057`)
        assert (
            router.dispatch(
                "POST",
                "/api/v1/ee/billing/warm-pool/claim",
                body=claim_body,
                headers={
                    "Authorization": "Bearer test-owner-acme",
                    "Idempotency-Key": "idem-http-unpaid-inv",
                },
                environ=env,
            ).status_code
            == 403
        )

        assert (
            router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
                body=json.dumps(
                    {
                        "action": "pay",
                        "invoice_ref": "INV-KODERA-2026-00777",
                        "payment_ref": "WIRE-777",
                        "amount_paid_minor": 720_000,
                    }
                ).encode(),
                headers={"Authorization": "Bearer test-owner-acme"},
                environ=env,
            ).status_code
            == 403
        )

        router.purchase_orders.register_core_payment(
            "INV-KODERA-2026-00777",
            "WIRE-777",
            organisation_id="org_acme",
            amount_minor=720_000,
            mark_invoice_paid=True,
        )
        pay_step = router.dispatch(
            "POST",
            f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
            body=json.dumps(
                {
                    "action": "pay",
                    "invoice_ref": "INV-KODERA-2026-00777",
                    "payment_ref": "WIRE-777",
                    "amount_paid_minor": 720_000,
                }
            ).encode(),
            headers=staff_hdr,
            environ=env,
        )
        assert pay_step.status_code == 200

        claim_resp = router.dispatch(
            "POST",
            "/api/v1/ee/billing/warm-pool/claim",
            body=claim_body,
            headers={
                "Authorization": "Bearer test-owner-acme",
                "Idempotency-Key": "idem-http-claim-01",
            },
            environ=env,
        )
        assert claim_resp.status_code == 201
        assert claim_resp.json()["replayed"] is False

        replay_resp = router.dispatch(
            "POST",
            "/api/v1/ee/billing/warm-pool/claim",
            body=claim_body,
            headers={
                "Authorization": "Bearer test-owner-acme",
                "Idempotency-Key": "idem-http-claim-01",
            },
            environ=env,
        )
        assert replay_resp.status_code == 200
        assert replay_resp.json()["replayed"] is True

        paid_po = router.dispatch(
            "GET",
            f"/api/v1/ee/billing/purchase-orders/{po_id}",
            headers={"Authorization": "Bearer test-owner-acme"},
            environ=env,
        )
        assert paid_po.status_code == 200
        assert paid_po.json()["state"] == "paid"

        commit_ok = router.dispatch(
            "POST",
            f"/api/v1/ee/billing/purchase-orders/{po_id}/commitment-check",
            body=json.dumps({"active_seats": 40, "used_storage_gb": 200}).encode(),
            headers={"Authorization": "Bearer test-owner-acme"},
            environ=env,
        )
        assert commit_ok.status_code == 200
        assert commit_ok.json()["within_commitment"] is True

        commit_over = router.dispatch(
            "POST",
            f"/api/v1/ee/billing/purchase-orders/{po_id}/commitment-check",
            body=json.dumps({"active_seats": 99, "used_storage_gb": 200}).encode(),
            headers={"Authorization": "Bearer test-owner-acme"},
            environ=env,
        )
        assert commit_over.status_code == 409

    def test_customer_owner_settlement_probe_is_refused_403_and_unverified_refs_fail_422(
        self,
    ) -> None:
        """Regression guard for `enterprise-billing-owner-settlement-probe.json`: a customer
        `org_owner` cannot self-invoice (`INV-KODERA-2026-00099`) or self-pay (`WIRE-SEPA-2026-8821`),
        and even `staff` / `X-Kodera-Internal-Token` receives `422` until the Core invoice and
        payment exist in Core's ledger."""
        env = {
            "KODERA_EDITION": "enterprise",
            "KODERA_EE_INTERNAL_TOKEN": "internal-ee-settlement-token-32b-ok!",
        }
        router = EnterpriseBillingRouter(backend="memory", authenticator=_staff_test_auth)
        owner_hdr = {"Authorization": "Bearer test-owner-acme"}
        staff_hdr = {"Authorization": "Bearer test-staff"}

        created = router.dispatch(
            "POST",
            "/api/v1/ee/billing/purchase-orders",
            body=json.dumps(
                {
                    "organisation_id": "org_acme",
                    "customer_po_reference": "BDC-PROBE-2026-99",
                    "plan_code": "sovereign",
                    "billing_months": 12,
                    "committed_seats": 100,
                    "committed_storage_gb": 500,
                    "subtotal_excl_vat_minor": 900_000,
                }
            ).encode(),
            headers=staff_hdr,
            environ=env,
        )
        assert created.status_code == 201
        po_id = created.json()["po_id"]

        assert (
            router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
                body=json.dumps({"action": "issue"}).encode(),
                headers=staff_hdr,
                environ=env,
            ).status_code
            == 200
        )
        assert (
            router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
                body=json.dumps({"action": "countersign", "signatory": "Customer CFO"}).encode(),
                headers=owner_hdr,
                environ=env,
            ).status_code
            == 200
        )

        # 1. Probe attempt: org_owner tries to bind unverified invoice -> 403 forbidden
        owner_inv = router.dispatch(
            "POST",
            f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
            body=json.dumps({"action": "invoice", "invoice_ref": "INV-KODERA-2026-00099"}).encode(),
            headers=owner_hdr,
            environ=env,
        )
        assert owner_inv.status_code == 403
        assert router.purchase_orders.get(po_id, environ=env).state == "countersigned"

        # 2. Staff tries to bind non-existent Core invoice -> 422 unverified_core_invoice
        staff_unverified_inv = router.dispatch(
            "POST",
            f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
            body=json.dumps({"action": "invoice", "invoice_ref": "INV-KODERA-2026-00099"}).encode(),
            headers=staff_hdr,
            environ=env,
        )
        assert staff_unverified_inv.status_code == 422

        # 3. Register Core invoice -> staff binds cleanly -> owner still gets 403 on `pay`
        router.purchase_orders.register_core_invoice(
            "INV-KODERA-2026-00099",
            organisation_id="org_acme",
            total_incl_vat_minor=1_080_000,
        )
        assert (
            router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
                body=json.dumps(
                    {"action": "invoice", "invoice_ref": "INV-KODERA-2026-00099"}
                ).encode(),
                headers=staff_hdr,
                environ=env,
            ).status_code
            == 200
        )

        owner_pay = router.dispatch(
            "POST",
            f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
            body=json.dumps(
                {
                    "action": "pay",
                    "invoice_ref": "INV-KODERA-2026-00099",
                    "payment_ref": "WIRE-SEPA-2026-8821",
                    "amount_paid_minor": 1_080_000,
                }
            ).encode(),
            headers=owner_hdr,
            environ=env,
        )
        assert owner_pay.status_code == 403
        assert router.purchase_orders.get(po_id, environ=env).state == "invoiced"

        # 4. Staff tries to pay with unverified wire reference -> 422 unverified_core_payment
        staff_unverified_pay = router.dispatch(
            "POST",
            f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
            body=json.dumps(
                {
                    "action": "pay",
                    "invoice_ref": "INV-KODERA-2026-00099",
                    "payment_ref": "WIRE-SEPA-2026-8821",
                    "amount_paid_minor": 1_080_000,
                }
            ).encode(),
            headers=staff_hdr,
            environ=env,
        )
        assert staff_unverified_pay.status_code == 422

        # 5. Register settled Core payment -> staff settles PO to `paid`
        router.purchase_orders.register_core_payment(
            "INV-KODERA-2026-00099",
            "WIRE-SEPA-2026-8821",
            organisation_id="org_acme",
            amount_minor=1_080_000,
            mark_invoice_paid=True,
        )
        settled = router.dispatch(
            "POST",
            f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
            body=json.dumps(
                {
                    "action": "pay",
                    "invoice_ref": "INV-KODERA-2026-00099",
                    "payment_ref": "WIRE-SEPA-2026-8821",
                    "amount_paid_minor": 1_080_000,
                }
            ).encode(),
            headers=staff_hdr,
            environ=env,
        )
        assert settled.status_code == 200
        assert settled.json()["state"] == "paid"


@pytest.fixture
def ee_billing_pg_world(settings):
    """Real RS256 OIDC trust + PostgreSQL identities/memberships across two tenants + staff."""
    import json as _json
    import time as _time

    import jwt
    from apps.identity.models import Identity, StaffRole, User
    from cryptography.hazmat.primitives.asymmetric import rsa
    from django.utils import timezone
    from test_customer_persistence_models import anchor, anchor_models, identity

    from config.environment import allowed_oidc_client_ids
    from services.identity.trusted_issuers import load_trust

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = _json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
    public.update(kid="ee-billing-kid", alg="RS256", use="sig", key_ops=["verify"])

    now_epoch = int(_time.time())

    def mint_jwt(issuer: str, subject: str, *, amr: list[str] | None = None) -> str:
        payload: dict[str, object] = {
            "iss": issuer,
            "sub": subject,
            "aud": "kodera-server",
            "iat": now_epoch,
            "exp": now_epoch + 600,
            "typ": "Bearer",
            "azp": "synthetic-console",
        }
        if amr is not None:
            payload["amr"] = amr
        return str(
            jwt.encode(
                payload,
                key,
                algorithm="RS256",
                headers={"kid": "ee-billing-kid"},
            )
        )

    staff_issuer = "https://identity.staff.test/realms/kodera-staff"
    settings.KODERA_STAFF_ISSUER = staff_issuer
    settings.KODERA_CONSOLE_CLIENT_ID = "synthetic-console"

    models = anchor_models()
    org_alpha, _, _ = anchor(models, slug="ee-alpha-" + uuid.uuid4().hex[:6])
    org_bravo, _, _ = anchor(models, slug="ee-bravo-" + uuid.uuid4().hex[:6])

    now = timezone.now()

    def make_customer(org, role: str, label: str) -> str:
        person = models.User.objects.create(
            email=f"{label}-{uuid.uuid4().hex[:6]}@customer.test",
            display_name=label,
        )
        sub = f"sub-{label}-{uuid.uuid4().hex[:8]}"
        identity(models, org, person, subject=sub)
        models.Membership.objects.create(
            user=person,
            organisation=org,
            role=role,
            state="active",
            accepted_at=now,
        )
        return mint_jwt(org.issuer, sub)

    staff_user = User.objects.create(
        email=f"staff-{uuid.uuid4().hex[:6]}@staff.test",
        enabled=True,
    )
    staff_sub = "staff-sub-" + uuid.uuid4().hex[:8]
    staff_id = Identity.objects.create(
        user=staff_user,
        organisation=None,
        issuer=staff_issuer,
        realm="kodera-staff",
        subject=staff_sub,
        email=staff_user.email,
        enabled=True,
    )
    StaffRole.objects.create(identity=staff_id, realm="kodera-staff", role="staff_operator")
    staff_token = mint_jwt(staff_issuer, staff_sub, amr=["pwd", "otp"])
    staff_no_mfa_token = mint_jwt(staff_issuer, staff_sub, amr=["pwd"])
    unknown_customer_token = mint_jwt(org_alpha.issuer, "sub-unknown-caller")

    entries = [
        {
            "lane": "staff",
            "issuer": staff_issuer,
            "generation": "ee-billing-test",
            "expires_at": now_epoch + 600,
            "public_jwks": {"keys": [public]},
        },
        {
            "lane": "customer",
            "issuer": org_alpha.issuer,
            "generation": "ee-billing-test",
            "expires_at": now_epoch + 600,
            "public_jwks": {"keys": [public]},
        },
        {
            "lane": "customer",
            "issuer": org_bravo.issuer,
            "generation": "ee-billing-test",
            "expires_at": now_epoch + 600,
            "public_jwks": {"keys": [public]},
        },
    ]
    allowed = allowed_oidc_client_ids({"KODERA_CONSOLE_CLIENT_ID": "synthetic-console"})
    settings.KODERA_AUTH_TRUST = load_trust(_json.dumps(entries), allowed_azp=allowed)

    return SimpleNamespace(
        org_alpha=org_alpha,
        org_bravo=org_bravo,
        staff_id=staff_id,
        mint_jwt=mint_jwt,
        org_alpha_id=str(org_alpha.id),
        org_bravo_id=str(org_bravo.id),
        staff_token=staff_token,
        staff_no_mfa_token=staff_no_mfa_token,
        unknown_customer_token=unknown_customer_token,
        alpha_owner_token=make_customer(org_alpha, "org_owner", "alpha-owner"),
        alpha_billing_token=make_customer(org_alpha, "org_billing", "alpha-billing"),
        alpha_admin_token=make_customer(org_alpha, "org_admin", "alpha-admin"),
        alpha_member_token=make_customer(org_alpha, "org_member", "alpha-member"),
        bravo_admin_token=make_customer(org_bravo, "org_admin", "bravo-admin"),
    )


@pytest.mark.django_db(transaction=True)
class TestEnterpriseBillingPostgresAuthAndDurability:
    def test_oidc_bearer_authentication_and_tenant_rbac_matrix(self, ee_billing_pg_world) -> None:
        w = ee_billing_pg_world
        env = {"KODERA_EDITION": "enterprise"}
        router = EnterpriseBillingRouter()

        def hdr(tok: str, **extra: str) -> dict[str, str]:
            return {"Authorization": f"Bearer {tok}", **extra}

        # 1. Anonymous & invalid Bearer tokens -> 401 with WWW-Authenticate: Bearer
        for bad_headers in (
            {},
            {"Authorization": "Basic dXNlcjpwYXNz"},
            {"Authorization": "Bearer not-a-jwt"},
        ):
            r401 = router.dispatch(
                "GET", "/api/v1/ee/billing/plans", headers=bad_headers, environ=env
            )
            assert r401.status_code == 401
            assert r401.headers["WWW-Authenticate"] == "Bearer"
            assert r401.content_type == "application/problem+json"

        # Staff without MFA or unknown customer identity -> 403 forbidden
        assert (
            router.dispatch(
                "GET",
                "/api/v1/ee/billing/plans",
                headers=hdr(w.staff_no_mfa_token),
                environ=env,
            ).status_code
            == 403
        )
        assert (
            router.dispatch(
                "GET",
                "/api/v1/ee/billing/plans",
                headers=hdr(w.unknown_customer_token),
                environ=env,
            ).status_code
            == 403
        )

        # 2. Staff-only warm-pool inspection & replenish routes refuse all customer roles (403)
        for cust_tok in (w.alpha_owner_token, w.alpha_admin_token, w.alpha_member_token):
            assert (
                router.dispatch(
                    "GET", "/api/v1/ee/billing/warm-pool", headers=hdr(cust_tok), environ=env
                ).status_code
                == 403
            )
            assert (
                router.dispatch(
                    "POST",
                    "/api/v1/ee/billing/warm-pool/replenish",
                    headers=hdr(cust_tok),
                    environ=env,
                ).status_code
                == 403
            )

        assert (
            router.dispatch(
                "GET", "/api/v1/ee/billing/warm-pool", headers=hdr(w.staff_token), environ=env
            ).status_code
            == 200
        )

        # 3. `org_member` gets 200 on `/plans` but 403 on quotes, warm-pool claim, and PO create
        assert (
            router.dispatch(
                "GET", "/api/v1/ee/billing/plans", headers=hdr(w.alpha_member_token), environ=env
            ).status_code
            == 200
        )
        assert (
            router.dispatch(
                "POST",
                "/api/v1/ee/billing/quotes",
                body=json.dumps(
                    {"organisation_id": w.org_alpha_id, "plan_code": "team", "seats": 10}
                ).encode(),
                headers=hdr(w.alpha_member_token),
                environ=env,
            ).status_code
            == 403
        )
        assert (
            router.dispatch(
                "POST",
                "/api/v1/ee/billing/warm-pool/claim",
                body=json.dumps(
                    {"organisation_id": w.org_alpha_id, "checkout_id": "cs_mem_1"}
                ).encode(),
                headers=hdr(w.alpha_member_token, **{"Idempotency-Key": "idem-mem-refused-1"}),
                environ=env,
            ).status_code
            == 403
        )
        po_payload = {
            "organisation_id": w.org_alpha_id,
            "customer_po_reference": "BDC-ALPHA-01",
            "plan_code": "sovereign",
            "billing_months": 12,
            "committed_seats": 30,
            "committed_storage_gb": 100,
            "subtotal_excl_vat_minor": 500_000,
        }
        assert (
            router.dispatch(
                "POST",
                "/api/v1/ee/billing/purchase-orders",
                body=json.dumps(po_payload).encode(),
                headers=hdr(w.alpha_member_token),
                environ=env,
            ).status_code
            == 403
        )

        # 4. Cross-tenant `org_admin` (`org_bravo`) targeting `org_alpha` -> 403 on every route
        assert (
            router.dispatch(
                "POST",
                "/api/v1/ee/billing/quotes",
                body=json.dumps(
                    {"organisation_id": w.org_alpha_id, "plan_code": "team", "seats": 10}
                ).encode(),
                headers=hdr(w.bravo_admin_token),
                environ=env,
            ).status_code
            == 403
        )
        assert (
            router.dispatch(
                "POST",
                "/api/v1/ee/billing/purchase-orders",
                body=json.dumps(po_payload).encode(),
                headers=hdr(w.bravo_admin_token),
                environ=env,
            ).status_code
            == 403
        )

        # 5. All customer roles (`org_owner`, `org_billing`, `org_admin`) are refused (403) on
        #    PO draft creation and `issue` (`BUG-0058` / `E02-003`); only staff may create & issue.
        for cust_tok in (w.alpha_owner_token, w.alpha_billing_token, w.alpha_admin_token):
            assert (
                router.dispatch(
                    "POST",
                    "/api/v1/ee/billing/purchase-orders",
                    body=json.dumps(po_payload).encode(),
                    headers=hdr(cust_tok),
                    environ=env,
                ).status_code
                == 403
            )

        staff_po = router.dispatch(
            "POST",
            "/api/v1/ee/billing/purchase-orders",
            body=json.dumps(po_payload).encode(),
            headers=hdr(w.staff_token),
            environ=env,
        )
        assert staff_po.status_code == 201
        po_id = staff_po.json()["po_id"]

        # Cross-tenant `bravo_admin` & same-tenant `alpha_member` cannot read or transition `po_id`
        for denied_tok in (w.bravo_admin_token, w.alpha_member_token, w.alpha_admin_token):
            assert (
                router.dispatch(
                    "GET",
                    f"/api/v1/ee/billing/purchase-orders/{po_id}",
                    headers=hdr(denied_tok),
                    environ=env,
                ).status_code
                == 403
            )
            assert (
                router.dispatch(
                    "POST",
                    f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
                    body=json.dumps({"action": "issue"}).encode(),
                    headers=hdr(denied_tok),
                    environ=env,
                ).status_code
                == 403
            )

        # Customer `org_owner` and `org_billing` also get 403 on `issue`; `staff` issues cleanly (200)
        for cust_tok in (w.alpha_owner_token, w.alpha_billing_token):
            assert (
                router.dispatch(
                    "POST",
                    f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
                    body=json.dumps({"action": "issue"}).encode(),
                    headers=hdr(cust_tok),
                    environ=env,
                ).status_code
                == 403
            )
        assert (
            router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
                body=json.dumps({"action": "issue"}).encode(),
                headers=hdr(w.staff_token),
                environ=env,
            ).status_code
            == 200
        )

        # Both `org_admin` AND `org_billing` are refused (403) on `countersign` (`E02-003`!)
        for non_owner_tok in (w.alpha_admin_token, w.alpha_billing_token):
            assert (
                router.dispatch(
                    "POST",
                    f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
                    body=json.dumps(
                        {"action": "countersign", "signatory": "Non-Owner Try"}
                    ).encode(),
                    headers=hdr(non_owner_tok),
                    environ=env,
                ).status_code
                == 403
            )

        # Same-tenant `org_owner` countersigns (200), while ALL customer roles (`org_owner`,
        # `org_billing`, `org_admin`) are refused (403) on `invoice` and `pay`!
        assert (
            router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
                body=json.dumps({"action": "countersign", "signatory": "Alpha Owner"}).encode(),
                headers=hdr(w.alpha_owner_token),
                environ=env,
            ).status_code
            == 200
        )
        for cust_tok in (w.alpha_owner_token, w.alpha_billing_token, w.alpha_admin_token):
            assert (
                router.dispatch(
                    "POST",
                    f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
                    body=json.dumps(
                        {"action": "invoice", "invoice_ref": "INV-KODERA-2026-00901"}
                    ).encode(),
                    headers=hdr(cust_tok),
                    environ=env,
                ).status_code
                == 403
            )

        # Staff attempting `invoice` BEFORE Core invoice exists gets 422 (`unverified_core_invoice`)
        assert (
            router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
                body=json.dumps(
                    {"action": "invoice", "invoice_ref": "INV-KODERA-2026-00901"}
                ).encode(),
                headers=hdr(w.staff_token),
                environ=env,
            ).status_code
            == 422
        )

        inv_901 = self._seed_core_invoice(
            organisation_id=w.org_alpha_id,
            number="KODERA-2026-00901",
            subtotal_excl_vat_minor=500_000,
            vat_amount_minor=100_000,
        )
        assert (
            router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
                body=json.dumps(
                    {"action": "invoice", "invoice_ref": "INV-KODERA-2026-00901"}
                ).encode(),
                headers=hdr(w.staff_token),
                environ=env,
            ).status_code
            == 200
        )

        # Customer `org_owner` and `org_billing` are also refused (403) on `pay`
        for cust_tok in (w.alpha_owner_token, w.alpha_billing_token):
            assert (
                router.dispatch(
                    "POST",
                    f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
                    body=json.dumps(
                        {
                            "action": "pay",
                            "invoice_ref": "INV-KODERA-2026-00901",
                            "payment_ref": "SEPA-ALPHA-901",
                            "amount_paid_minor": 600_000,
                        }
                    ).encode(),
                    headers=hdr(cust_tok),
                    environ=env,
                ).status_code
                == 403
            )

        # Staff attempting `pay` before Core payment settles gets 422 (`unverified_core_payment`)
        assert (
            router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
                body=json.dumps(
                    {
                        "action": "pay",
                        "invoice_ref": "INV-KODERA-2026-00901",
                        "payment_ref": "SEPA-ALPHA-901",
                        "amount_paid_minor": 600_000,
                    }
                ).encode(),
                headers=hdr(w.staff_token),
                environ=env,
            ).status_code
            == 422
        )

        self._settle_core_invoice(inv_901, payment_ref="SEPA-ALPHA-901")
        assert (
            router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
                body=json.dumps(
                    {
                        "action": "pay",
                        "invoice_ref": "INV-KODERA-2026-00901",
                        "payment_ref": "SEPA-ALPHA-901",
                        "amount_paid_minor": 600_000,
                    }
                ).encode(),
                headers=hdr(w.staff_token),
                environ=env,
            ).status_code
            == 200
        )

        # Cross-tenant `bravo_admin` also gets 403 on commitment-check
        assert (
            router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{po_id}/commitment-check",
                body=json.dumps({"active_seats": 10, "used_storage_gb": 50}).encode(),
                headers=hdr(w.bravo_admin_token),
                environ=env,
            ).status_code
            == 403
        )

    @staticmethod
    def _seed_core_invoice(
        *,
        organisation_id: str,
        number: str,
        subtotal_excl_vat_minor: int,
        vat_amount_minor: int,
    ):
        from apps.billing.models import Invoice, InvoiceLine
        from billing_fiscal_fixtures import register_test_fiscal_periods
        from django.utils import timezone

        register_test_fiscal_periods()
        now = timezone.now()
        inv = Invoice.objects.create(
            organisation_id=organisation_id,
            subscription=None,
            order=None,
            number=None,
            state="draft",
            currency="EUR",
            vat_regime="fr_standard",
            vat_mention=None,
            issuer_legal_name="Samourai Coop",
            issuer_address="1 rue Synthetique, 75000 Paris",
            issuer_country="FR",
            issuer_siren="000000000",
            issuer_vat_number="FR00000000000",
            customer_legal_name="Enterprise Tenant SAS",
            customer_address_line1="10 avenue Synthetique",
            customer_postal_code="75001",
            customer_city="Paris",
            customer_country="FR",
            customer_siren="000000001",
            total_excl_vat_minor=subtotal_excl_vat_minor,
            vat_amount_minor=vat_amount_minor,
            total_incl_vat_minor=subtotal_excl_vat_minor + vat_amount_minor,
            amount_paid_minor=0,
        )
        InvoiceLine.objects.create(
            invoice=inv,
            position=1,
            description="Enterprise purchase order commitment",
            plan_code="sovereign",
            plan_version=1,
            pack_code="visio-docs",
            capacity_tier_code="M",
            quantity=1,
            unit_amount_minor=subtotal_excl_vat_minor,
            total_excl_vat_minor=subtotal_excl_vat_minor,
            vat_rate_bp=2000,
            vat_amount_minor=vat_amount_minor,
            period_start=now,
            period_end=now + timedelta(days=365),
        )
        inv.number = number
        inv.state = "issued"
        inv.issued_at = now
        inv.due_at = now + timedelta(days=30)
        inv.save()
        return inv

    @staticmethod
    def _settle_core_invoice(inv, *, payment_ref: str) -> None:
        from apps.billing.models import Payment
        from django.utils import timezone

        now = timezone.now()
        Payment.objects.create(
            organisation_id=inv.organisation_id,
            invoice=inv,
            payment_link=None,
            provider="sepa_wire",
            provider_ref=payment_ref,
            state="succeeded",
            amount_minor=inv.total_incl_vat_minor,
            currency=inv.currency,
            last_event_at=now,
            allocated=True,
        )
        inv.state = "paid"
        inv.amount_paid_minor = inv.total_incl_vat_minor
        inv.paid_at = now
        inv.save(update_fields=["state", "amount_paid_minor", "paid_at", "updated_at"])

    def test_multi_worker_postgresql_durability_across_independent_router_instances(
        self, ee_billing_pg_world
    ) -> None:
        """Prove Worker A and fresh Worker B share durable warm-pool and PO state via PostgreSQL."""
        w = ee_billing_pg_world
        env = {"KODERA_EDITION": "enterprise"}
        staff_hdr = {"Authorization": f"Bearer {w.staff_token}"}
        owner_hdr = {"Authorization": f"Bearer {w.alpha_owner_token}"}

        # Worker A: replenish + mark ready + claim slot + create & issue PO
        worker_a = EnterpriseBillingRouter()
        rep = worker_a.dispatch(
            "POST",
            "/api/v1/ee/billing/warm-pool/replenish",
            body=json.dumps({"region": "fr-par-pg", "profile_ref": "pg-durable-v1"}).encode(),
            headers=staff_hdr,
            environ=env,
        )
        assert rep.status_code == 200
        slot_id = rep.json()["created_slots"][0]["slot_id"]
        worker_a.warm_pool.mark_ready(slot_id)

        inv_955 = self._seed_core_invoice(
            organisation_id=w.org_alpha_id,
            number="KODERA-2026-00955",
            subtotal_excl_vat_minor=500_000,
            vat_amount_minor=100_000,
        )
        self._settle_core_invoice(inv_955, payment_ref="WIRE-PG-955")

        po_created = worker_a.dispatch(
            "POST",
            "/api/v1/ee/billing/purchase-orders",
            body=json.dumps(
                {
                    "organisation_id": w.org_alpha_id,
                    "customer_po_reference": "BDC-PG-DURABLE-01",
                    "plan_code": "sovereign",
                    "billing_months": 12,
                    "committed_seats": 40,
                    "committed_storage_gb": 200,
                    "subtotal_excl_vat_minor": 500_000,
                }
            ).encode(),
            headers=staff_hdr,
            environ=env,
        )
        assert po_created.status_code == 201
        po_id = po_created.json()["po_id"]

        issued_a = worker_a.dispatch(
            "POST",
            f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
            body=json.dumps({"action": "issue"}).encode(),
            headers=staff_hdr,
            environ=env,
        )
        assert issued_a.status_code == 200
        assert issued_a.json()["state"] == "issued"

        # Worker B: brand-new router instance with zero shared Python memory
        worker_b = EnterpriseBillingRouter()
        assert worker_b is not worker_a
        assert worker_b.purchase_orders is not worker_a.purchase_orders
        assert worker_b.warm_pool is not worker_a.warm_pool

        # Worker B reads PO created on Worker A; customer owner countersigns, staff binds & settles
        fetched_b = worker_b.dispatch(
            "GET",
            f"/api/v1/ee/billing/purchase-orders/{po_id}",
            headers=owner_hdr,
            environ=env,
        )
        assert fetched_b.status_code == 200
        assert fetched_b.json()["state"] == "issued"

        for step_hdr, step_payload in (
            (owner_hdr, {"action": "countersign", "signatory": "Worker B CFO"}),
            (staff_hdr, {"action": "invoice", "invoice_ref": "INV-KODERA-2026-00955"}),
            (
                staff_hdr,
                {
                    "action": "pay",
                    "invoice_ref": "INV-KODERA-2026-00955",
                    "payment_ref": "WIRE-PG-955",
                    "amount_paid_minor": 600_000,
                },
            ),
        ):
            step_b = worker_b.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
                body=json.dumps(step_payload).encode(),
                headers=step_hdr,
                environ=env,
            )
            assert step_b.status_code == 200

        # Worker A sees paid state written by Worker B and claims warm-pool slot (`201`)!
        final_a = worker_a.dispatch(
            "GET",
            f"/api/v1/ee/billing/purchase-orders/{po_id}",
            headers=owner_hdr,
            environ=env,
        )
        assert final_a.status_code == 200
        assert final_a.json()["state"] == "paid"

        claim_payload = json.dumps(
            {
                "organisation_id": w.org_alpha_id,
                "checkout_id": "WIRE-PG-955",
                "region": "fr-par-pg",
                "profile_ref": "pg-durable-v1",
            }
        ).encode()
        claim_a = worker_a.dispatch(
            "POST",
            "/api/v1/ee/billing/warm-pool/claim",
            body=claim_payload,
            headers={**owner_hdr, "Idempotency-Key": "idem-pg-multiworker-01"},
            environ=env,
        )
        assert claim_a.status_code == 201
        assert claim_a.json()["slot"]["slot_id"] == slot_id
        assert claim_a.json()["replayed"] is False

        # Worker B replays exact same Idempotency-Key warm-pool claim -> 200 replayed=True, same slot_id
        claim_b = worker_b.dispatch(
            "POST",
            "/api/v1/ee/billing/warm-pool/claim",
            body=claim_payload,
            headers={**owner_hdr, "Idempotency-Key": "idem-pg-multiworker-01"},
            environ=env,
        )
        assert claim_b.status_code == 200
        assert claim_b.json()["replayed"] is True
        assert claim_b.json()["slot"]["slot_id"] == slot_id

        # Auto-expiry persists in PostgreSQL across workers even when issue() raises
        t0 = datetime(2026, 11, 14, 12, 0, tzinfo=UTC)
        expiring = worker_a.purchase_orders.create_draft(
            organisation_id=w.org_alpha_id,
            customer_po_reference="BDC-PG-EXPIRE-01",
            committed_seats=25,
            committed_storage_gb=100,
            subtotal_excl_vat_minor=400_000,
            created_at=t0,
            expires_at=t0 + timedelta(days=1),
            environ=env,
        )
        with pytest.raises(InvalidPurchaseOrderTransitionError):
            worker_b.purchase_orders.issue(expiring.po_id, at=t0 + timedelta(days=2), environ=env)
        assert worker_a.purchase_orders.get(expiring.po_id, environ=env).state == "expired"

    def test_kodera_api_writer_role_grants_and_resolve_member_authority(
        self, ee_billing_pg_world
    ) -> None:
        """Prove `ee/billing/` runs cleanly under `kodera_api` grants (`SET ROLE`) with zero DDL."""
        from django.db import connection
        from test_intake_writer_role import INSUFFICIENT_PRIVILEGE, acting_as, current_user, refused

        from core.db.api_database_boundary import assert_writer_grants
        from core.db.api_writer_role import grant_statements

        w = ee_billing_pg_world
        internal_tok = "ee-internal-" + ("a" * 24)
        env = {
            "KODERA_EDITION": "enterprise",
            "KODERA_EE_INTERNAL_TOKEN": internal_tok,
        }
        staff_hdr = {"Authorization": f"Bearer {w.staff_token}"}
        internal_hdr = {"X-Kodera-Internal-Token": internal_tok}
        owner_hdr = {"Authorization": f"Bearer {w.alpha_owner_token}"}
        billing_hdr = {"Authorization": f"Bearer {w.alpha_billing_token}"}

        # Core ledger rows seeded before switching to `kodera_api` (which holds SELECT on ledger)
        inv_977 = self._seed_core_invoice(
            organisation_id=w.org_alpha_id,
            number="KODERA-2026-00977",
            subtotal_excl_vat_minor=500_000,
            vat_amount_minor=100_000,
        )
        self._settle_core_invoice(inv_977, payment_ref="WIRE-WR-977")

        role = f"ee_billing_writer_{uuid.uuid4().hex[:10]}"
        with connection.cursor() as cursor:
            cursor.execute(
                f'CREATE ROLE "{role}" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
            )
            for statement in grant_statements(role):
                cursor.execute(statement)
            assert_writer_grants(cursor, role)

        try:
            with acting_as(role):
                assert current_user() == role
                router = EnterpriseBillingRouter()

                rep = router.dispatch(
                    "POST",
                    "/api/v1/ee/billing/warm-pool/replenish",
                    body=json.dumps({"region": "fr-par-wr", "profile_ref": "wr-v1"}).encode(),
                    headers=staff_hdr,
                    environ=env,
                )
                assert rep.status_code == 200
                slot_id = rep.json()["created_slots"][0]["slot_id"]
                router.warm_pool.mark_ready(slot_id)

                po_res = router.dispatch(
                    "POST",
                    "/api/v1/ee/billing/purchase-orders",
                    body=json.dumps(
                        {
                            "organisation_id": w.org_alpha_id,
                            "customer_po_reference": "BDC-WR-EE-01",
                            "plan_code": "sovereign",
                            "billing_months": 12,
                            "committed_seats": 30,
                            "committed_storage_gb": 100,
                            "subtotal_excl_vat_minor": 500_000,
                        }
                    ).encode(),
                    headers=staff_hdr,
                    environ=env,
                )
                assert po_res.status_code == 201
                po_id = po_res.json()["po_id"]

                for step_hdr, step_payload in (
                    (staff_hdr, {"action": "issue"}),
                    (owner_hdr, {"action": "countersign", "signatory": "Alpha CFO"}),
                ):
                    step_res = router.dispatch(
                        "POST",
                        f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
                        body=json.dumps(step_payload).encode(),
                        headers=step_hdr,
                        environ=env,
                    )
                    assert step_res.status_code == 200

                # Customer billing/owner roles are strictly refused (403) on settlement
                assert (
                    router.dispatch(
                        "POST",
                        f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
                        body=json.dumps(
                            {"action": "invoice", "invoice_ref": "INV-KODERA-2026-00977"}
                        ).encode(),
                        headers=billing_hdr,
                        environ=env,
                    ).status_code
                    == 403
                )

                # Staff Bearer binds verified Core invoice; internal reconciliation token settles pay
                assert (
                    router.dispatch(
                        "POST",
                        f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
                        body=json.dumps(
                            {"action": "invoice", "invoice_ref": "INV-KODERA-2026-00977"}
                        ).encode(),
                        headers=staff_hdr,
                        environ=env,
                    ).status_code
                    == 200
                )
                assert (
                    router.dispatch(
                        "POST",
                        f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
                        body=json.dumps(
                            {
                                "action": "pay",
                                "invoice_ref": "INV-KODERA-2026-00977",
                                "payment_ref": "WIRE-WR-977",
                                "amount_paid_minor": 600_000,
                            }
                        ).encode(),
                        headers=internal_hdr,
                        environ=env,
                    ).status_code
                    == 200
                )

                claimed = router.dispatch(
                    "POST",
                    "/api/v1/ee/billing/warm-pool/claim",
                    body=json.dumps(
                        {
                            "organisation_id": w.org_alpha_id,
                            "checkout_id": "WIRE-WR-977",
                            "region": "fr-par-wr",
                            "profile_ref": "wr-v1",
                        }
                    ).encode(),
                    headers={**owner_hdr, "Idempotency-Key": "idem-wr-ee-claim-01"},
                    environ=env,
                )
                assert claimed.status_code == 201

                assert refused("CREATE TABLE ee_forbidden_probe (x int)") == INSUFFICIENT_PRIVILEGE
                assert (
                    refused("UPDATE ee_billing_purchase_orders SET subtotal_excl_vat_minor = 0")
                    == INSUFFICIENT_PRIVILEGE
                )
                assert refused("DELETE FROM ee_billing_purchase_orders") == INSUFFICIENT_PRIVILEGE
        finally:
            with connection.cursor() as cursor:
                cursor.execute("RESET ROLE")
                cursor.execute(f'DROP OWNED BY "{role}"')
                cursor.execute(f'DROP ROLE "{role}"')

    def test_django_http_client_mounts_ee_billing_routes_with_edition_and_settlement_guards(
        self,
        ee_billing_pg_world,
        monkeypatch,
    ) -> None:
        """Prove `/api/v1/ee/billing/*` is mounted end-to-end over the real Django WSGI/HTTP
        middleware stack (`Client()`), returning `404` in Community mode and enforcing RBAC +
        Core ledger settlement in Enterprise mode."""
        from django.test import Client

        w = ee_billing_pg_world
        client = Client()
        internal_tok = "ee-http-internal-" + ("b" * 20)

        # 1. Community mode -> 404 on every `/api/v1/ee/billing/*` route
        monkeypatch.setenv("KODERA_EDITION", "community")
        r_comm_plans = client.get(
            "/api/v1/ee/billing/plans",
            HTTP_AUTHORIZATION=f"Bearer {w.staff_token}",
        )
        assert r_comm_plans.status_code == 404

        # 2. Enterprise mode: anonymous -> 401; wrong internal token -> 401; customer owner -> 200/201
        monkeypatch.setenv("KODERA_EDITION", "enterprise")
        monkeypatch.setenv("KODERA_EE_INTERNAL_TOKEN", internal_tok)

        r_anon = client.get("/api/v1/ee/billing/plans")
        assert r_anon.status_code == 401
        assert r_anon.headers["WWW-Authenticate"] == "Bearer"

        r_bad_internal = client.get(
            "/api/v1/ee/billing/plans",
            HTTP_X_KODERA_INTERNAL_TOKEN="ee-http-internal-" + ("c" * 20),
        )
        assert r_bad_internal.status_code == 401

        r_plans = client.get(
            "/api/v1/ee/billing/plans",
            HTTP_AUTHORIZATION=f"Bearer {w.alpha_owner_token}",
        )
        assert r_plans.status_code == 200
        assert r_plans.json()["min_gross_margin_bps"] == 4_400

        r_po = client.post(
            "/api/v1/ee/billing/purchase-orders",
            data=json.dumps(
                {
                    "organisation_id": w.org_alpha_id,
                    "customer_po_reference": "BDC-HTTP-WSGI-01",
                    "plan_code": "sovereign",
                    "billing_months": 12,
                    "committed_seats": 100,
                    "committed_storage_gb": 500,
                    "subtotal_excl_vat_minor": 900_000,
                }
            ).encode("utf-8"),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {w.staff_token}",
        )
        assert r_po.status_code == 201
        po_id = r_po.json()["po_id"]

        for step_tok, payload in (
            (w.staff_token, {"action": "issue"}),
            (w.alpha_owner_token, {"action": "countersign", "signatory": "WSGI Customer Owner"}),
        ):
            r_step = client.post(
                f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
                data=json.dumps(payload).encode("utf-8"),
                content_type="application/json",
                HTTP_AUTHORIZATION=f"Bearer {step_tok}",
            )
            assert r_step.status_code == 200

        # 3. Exact `enterprise-billing-owner-settlement-probe.json` over real Django HTTP -> 403
        r_owner_inv = client.post(
            f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
            data=json.dumps({"action": "invoice", "invoice_ref": "INV-KODERA-2026-00099"}).encode(
                "utf-8"
            ),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {w.alpha_owner_token}",
        )
        assert r_owner_inv.status_code == 403

        # 4. Internal token before Core invoice exists -> 422; after Core invoice + payment -> 200
        r_unverified = client.post(
            f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
            data=json.dumps({"action": "invoice", "invoice_ref": "INV-KODERA-2026-00099"}).encode(
                "utf-8"
            ),
            content_type="application/json",
            HTTP_X_KODERA_INTERNAL_TOKEN=internal_tok,
        )
        assert r_unverified.status_code == 422

        inv_099 = self._seed_core_invoice(
            organisation_id=w.org_alpha_id,
            number="KODERA-2026-00099",
            subtotal_excl_vat_minor=900_000,
            vat_amount_minor=180_000,
        )
        r_staff_inv = client.post(
            f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
            data=json.dumps({"action": "invoice", "invoice_ref": "INV-KODERA-2026-00099"}).encode(
                "utf-8"
            ),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {w.staff_token}",
        )
        assert r_staff_inv.status_code == 200

        r_owner_pay = client.post(
            f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
            data=json.dumps(
                {
                    "action": "pay",
                    "invoice_ref": "INV-KODERA-2026-00099",
                    "payment_ref": "WIRE-SEPA-2026-8821",
                    "amount_paid_minor": 1_080_000,
                }
            ).encode("utf-8"),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {w.alpha_owner_token}",
        )
        assert r_owner_pay.status_code == 403

        self._settle_core_invoice(inv_099, payment_ref="WIRE-SEPA-2026-8821")
        r_internal_pay = client.post(
            f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
            data=json.dumps(
                {
                    "action": "pay",
                    "invoice_ref": "INV-KODERA-2026-00099",
                    "payment_ref": "WIRE-SEPA-2026-8821",
                    "amount_paid_minor": 1_080_000,
                }
            ).encode("utf-8"),
            content_type="application/json",
            HTTP_X_KODERA_INTERNAL_TOKEN=internal_tok,
        )
        assert r_internal_pay.status_code == 200
        assert r_internal_pay.json()["state"] == "paid"

    def test_two_connection_in_transaction_reauthorization_and_nowait_fences(
        self,
        ee_billing_pg_world,
    ) -> None:
        """Prove in-transaction caller reauthorization (`FOR SHARE NOWAIT` + shared
        privacy cutoff lock) closes the TOCTOU window between `authenticate_bearer_header` and
        every store read/write across two real PostgreSQL connections and `SET ROLE` writer grants:
        1. Pre-captured `BillingPrincipal` demoted (`org_owner -> org_admin`), disabled, or
           staff-revoked on `conn2` BEFORE the store transaction fails closed with `403`.
        2. Reverse-order held `FOR NO KEY UPDATE` on `orgs_membership` / `identity_identity` /
           `identity_staffrole` or exclusive cutoff lock on `conn2` returns `409 Conflict`
           immediately (`NOWAIT`) with rollback.
        3. Admitted `_acquire_ee_caller_fence` on `conn1` blocks concurrent membership revocation
           and org-erasure cutoff on `conn2` until commit."""

        import psycopg
        from django.db import connection
        from test_intake_writer_role import acting_as

        from core.db.api_writer_role import grant_statements
        from ee.billing.api import (
            _to_caller_authority,
            authenticate_bearer_header,
        )
        from ee.billing.storage import _acquire_ee_caller_fence

        w = ee_billing_pg_world
        env = {"KODERA_EDITION": "enterprise"}

        # Capture pre-authenticated principals BEFORE authority mutations on conn2
        owner_principal = authenticate_bearer_header(
            {"authorization": f"Bearer {w.alpha_owner_token}"}
        )
        staff_principal = authenticate_bearer_header({"authorization": f"Bearer {w.staff_token}"})
        assert owner_principal.live_authority is True
        assert staff_principal.live_authority is True

        seed_router = EnterpriseBillingRouter()
        rep = seed_router.dispatch(
            "POST",
            "/api/v1/ee/billing/warm-pool/replenish",
            body=json.dumps({"region": "fr-par-toctou", "profile_ref": "toctou-v1"}).encode(),
            headers={"Authorization": f"Bearer {w.staff_token}"},
            environ=env,
        )
        assert rep.status_code == 200
        slot_id = rep.json()["created_slots"][0]["slot_id"]
        seed_router.warm_pool.mark_ready(slot_id)

        po_res = seed_router.dispatch(
            "POST",
            "/api/v1/ee/billing/purchase-orders",
            body=json.dumps(
                {
                    "organisation_id": w.org_alpha_id,
                    "customer_po_reference": "BDC-TOCTOU-01",
                    "plan_code": "sovereign",
                    "billing_months": 12,
                    "committed_seats": 30,
                    "committed_storage_gb": 100,
                    "subtotal_excl_vat_minor": 500_000,
                }
            ).encode(),
            headers={"Authorization": f"Bearer {w.staff_token}"},
            environ=env,
        )
        assert po_res.status_code == 201
        po_id = po_res.json()["po_id"]
        assert (
            seed_router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
                body=json.dumps({"action": "issue"}).encode(),
                headers={"Authorization": f"Bearer {w.staff_token}"},
                environ=env,
            ).status_code
            == 200
        )

        inv_toctou = self._seed_core_invoice(
            organisation_id=w.org_alpha_id,
            number="KODERA-2026-00988",
            subtotal_excl_vat_minor=500_000,
            vat_amount_minor=100_000,
        )
        self._settle_core_invoice(inv_toctou, payment_ref="WIRE-TOCTOU-988")

        def _owner_auth(_hdrs: Mapping[str, str]) -> BillingPrincipal:
            return owner_principal

        def _staff_auth(_hdrs: Mapping[str, str]) -> BillingPrincipal:
            return staff_principal

        owner_router = EnterpriseBillingRouter(authenticator=_owner_auth)
        staff_router = EnterpriseBillingRouter(authenticator=_staff_auth)

        cfg = connection.settings_dict
        with psycopg.connect(
            host=cfg["HOST"],
            port=cfg["PORT"],
            dbname=cfg["NAME"],
            user=cfg["USER"],
            password=cfg["PASSWORD"],
            autocommit=False,
        ) as conn2:
            # 1a. Demote `org_owner -> org_admin` on conn2 AFTER `owner_principal` was minted:
            #     `countersign` requires live `org_owner` -> must fail closed with 403!
            conn2.execute(
                "UPDATE orgs_membership SET role = 'org_admin', updated_at = clock_timestamp()"
                " WHERE user_id = %s AND organisation_id = %s",
                [owner_principal.user_id, w.org_alpha_id],
            )
            conn2.commit()

            demoted_cs = owner_router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
                body=json.dumps({"action": "countersign", "signatory": "Demoted Owner"}).encode(),
                headers={"Authorization": "Bearer pre-verified"},
                environ=env,
            )
            assert demoted_cs.status_code == 403
            assert seed_router.purchase_orders.get(po_id, environ=env).state == "issued"

            # 1b. Disable customer Identity on conn2 -> quotes, claim, create PO, list PO all -> 403
            conn2.execute(
                "UPDATE orgs_membership SET role = 'org_owner', updated_at = clock_timestamp()"
                " WHERE user_id = %s AND organisation_id = %s",
                [owner_principal.user_id, w.org_alpha_id],
            )
            conn2.execute(
                "UPDATE identity_identity SET enabled = false, updated_at = clock_timestamp()"
                " WHERE user_id = %s AND organisation_id = %s",
                [owner_principal.user_id, w.org_alpha_id],
            )
            conn2.commit()

            for method, path, payload, extra_hdr in (
                (
                    "POST",
                    "/api/v1/ee/billing/quotes",
                    {"organisation_id": w.org_alpha_id, "plan_code": "team", "seats": 10},
                    {},
                ),
                (
                    "POST",
                    "/api/v1/ee/billing/warm-pool/claim",
                    {
                        "organisation_id": w.org_alpha_id,
                        "checkout_id": "cs_disabled_id_01",
                        "region": "fr-par-toctou",
                        "profile_ref": "toctou-v1",
                    },
                    {"Idempotency-Key": "idem-disabled-id-01"},
                ),
                (
                    "POST",
                    "/api/v1/ee/billing/purchase-orders",
                    {
                        "organisation_id": w.org_alpha_id,
                        "customer_po_reference": "BDC-DISABLED-01",
                        "plan_code": "sovereign",
                        "billing_months": 12,
                        "committed_seats": 30,
                        "committed_storage_gb": 100,
                        "subtotal_excl_vat_minor": 500_000,
                    },
                    {},
                ),
                ("GET", f"/api/v1/ee/billing/purchase-orders/{po_id}", None, {}),
            ):
                res_403 = owner_router.dispatch(
                    method,
                    path,
                    body=json.dumps(payload).encode() if payload is not None else b"",
                    headers={"Authorization": "Bearer pre-verified", **extra_hdr},
                    environ=env,
                )
                assert res_403.status_code == 403, (method, path)

            # Restore customer Identity & countersign cleanly so we can test staff revocation on `invoice`
            conn2.execute(
                "UPDATE identity_identity SET enabled = true, updated_at = clock_timestamp()"
                " WHERE user_id = %s AND organisation_id = %s",
                [owner_principal.user_id, w.org_alpha_id],
            )
            conn2.commit()

            assert (
                owner_router.dispatch(
                    "POST",
                    f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
                    body=json.dumps({"action": "countersign", "signatory": "Live Owner"}).encode(),
                    headers={"Authorization": "Bearer pre-verified"},
                    environ=env,
                ).status_code
                == 200
            )

            # 1c. Revoke `StaffRole` on conn2 AFTER `staff_principal` was minted -> replenish & invoice -> 403
            conn2.execute(
                "UPDATE identity_staffrole SET revoked_at = clock_timestamp()"
                " WHERE identity_id = %s",
                [w.staff_id.id],
            )
            conn2.commit()

            assert (
                staff_router.dispatch(
                    "POST",
                    "/api/v1/ee/billing/warm-pool/replenish",
                    body=json.dumps(
                        {"region": "fr-par-toctou", "profile_ref": "toctou-v1"}
                    ).encode(),
                    headers={"Authorization": "Bearer pre-verified-staff"},
                    environ=env,
                ).status_code
                == 403
            )
            assert (
                staff_router.dispatch(
                    "POST",
                    f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
                    body=json.dumps(
                        {"action": "invoice", "invoice_ref": "INV-KODERA-2026-00988"}
                    ).encode(),
                    headers={"Authorization": "Bearer pre-verified-staff"},
                    environ=env,
                ).status_code
                == 403
            )
            assert seed_router.purchase_orders.get(po_id, environ=env).state == "countersigned"

            conn2.execute(
                "INSERT INTO identity_staffrole"
                " (id, created_at, updated_at, identity_id, realm, role, revoked_at)"
                " VALUES (%s, clock_timestamp(), clock_timestamp(), %s, 'kodera-staff', 'staff_operator', NULL)",
                [uuid.uuid4(), w.staff_id.id],
            )
            conn2.commit()

            # 2. Reverse-order lock contention (`NOWAIT -> 409`) including under `SET ROLE` (`kodera_api`)
            role = f"ee_toctou_writer_{uuid.uuid4().hex[:10]}"
            with connection.cursor() as cur:
                cur.execute(
                    f'CREATE ROLE "{role}" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
                )
                for stmt in grant_statements(role):
                    cur.execute(stmt)

            try:
                with acting_as(role):
                    conn2.execute(
                        "SELECT 1 FROM orgs_membership"
                        " WHERE user_id = %s AND organisation_id = %s FOR NO KEY UPDATE",
                        [owner_principal.user_id, w.org_alpha_id],
                    )
                    r_claim_409 = owner_router.dispatch(
                        "POST",
                        "/api/v1/ee/billing/warm-pool/claim",
                        body=json.dumps(
                            {
                                "organisation_id": w.org_alpha_id,
                                "checkout_id": "cs_nowait_409",
                                "region": "fr-par-toctou",
                                "profile_ref": "toctou-v1",
                            }
                        ).encode(),
                        headers={
                            "Authorization": "Bearer pre-verified",
                            "Idempotency-Key": "aaaa-aaaa-0001",
                        },
                        environ=env,
                    )
                    assert r_claim_409.status_code == 409
                    assert r_claim_409.content_type == "application/problem+json"

                    r_po_409 = owner_router.dispatch(
                        "GET",
                        f"/api/v1/ee/billing/purchase-orders/{po_id}",
                        headers={"Authorization": "Bearer pre-verified"},
                        environ=env,
                    )
                    assert r_po_409.status_code == 409
                    conn2.rollback()

                    conn2.execute(
                        "SELECT 1 FROM identity_staffrole WHERE identity_id = %s FOR NO KEY UPDATE",
                        [w.staff_id.id],
                    )
                    r_staff_409 = staff_router.dispatch(
                        "POST",
                        f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
                        body=json.dumps(
                            {"action": "invoice", "invoice_ref": "INV-KODERA-2026-00988"}
                        ).encode(),
                        headers={"Authorization": "Bearer pre-verified-staff"},
                        environ=env,
                    )
                    assert r_staff_409.status_code == 409
                    conn2.rollback()

                    # Once contention clears, `kodera_api` writer role completes `invoice` cleanly (200)
                    r_staff_ok = staff_router.dispatch(
                        "POST",
                        f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
                        body=json.dumps(
                            {"action": "invoice", "invoice_ref": "INV-KODERA-2026-00988"}
                        ).encode(),
                        headers={"Authorization": "Bearer pre-verified-staff"},
                        environ=env,
                    )
                    assert r_staff_ok.status_code == 200
            finally:
                with connection.cursor() as cur:
                    cur.execute("RESET ROLE")
                    cur.execute(f'DROP OWNED BY "{role}"')
                    cur.execute(f'DROP ROLE "{role}"')

            # 3. Forward-order fence on conn1 blocks concurrent membership mutation & org cutoff lock
            caller_auth = _to_caller_authority(
                owner_principal,
                allowed_org_roles=frozenset({"org_owner"}),
            )
            assert caller_auth is not None
            from django.db import transaction

            with transaction.atomic(), connection.cursor() as cur1:
                _acquire_ee_caller_fence(cur1, caller_auth, target_organisation_id=w.org_alpha_id)
                conn2.execute("SET LOCAL lock_timeout = '100ms'")
                with pytest.raises(psycopg.errors.LockNotAvailable):
                    conn2.execute(
                        "UPDATE orgs_membership SET role = 'org_member'"
                        " WHERE user_id = %s AND organisation_id = %s",
                        [owner_principal.user_id, w.org_alpha_id],
                    )
                conn2.rollback()

                conn2.execute("SET LOCAL lock_timeout = '100ms'")
                with pytest.raises(psycopg.errors.LockNotAvailable):
                    conn2.execute(
                        "SELECT pg_advisory_xact_lock("
                        "hashtextextended('privacy_erasure_cutoff:' || %s, 0))",
                        [w.org_alpha_id],
                    )
                conn2.rollback()

    def test_enterprise_billing_organisation_and_account_privacy_erasure_end_to_end(
        self,
        ee_billing_pg_world,
    ) -> None:
        """Enterprise billing organisation and account privacy erasure invariants:
        1. Account privacy erasure (`begin_account_erasure` + `advance_account_erasure`) scrubs
           signatory personal data (`countersigned_by = 'erased:<user_uuid>'`, `pii_scrubbed_at`
           set) on retained accounting POs while preserving Core `Invoice` + PO financial fields,
           and reaches `complete=True`.
        2. Organisation privacy erasure (`begin_erasure` + `advance_erasure`) evicts & releases
           claimed warm-pool slots, deletes ephemeral `draft`/`issued` POs, retains `countersigned`
           and `paid` accounting POs with `countersigned_by = 'erased'` &
           `customer_po_reference = 'REDACTED-' || po_number`, blocks post-cutoff customer/staff/
           internal writes (`403`/`409` / SQLSTATE `23514`), leaves sibling `org_bravo` POs/slots
           untouched, and reaches `complete=True`.
        3. Composable journal triggers `aa_01_passport_erasure` & `aa_02_ee_billing_erasure` are
           registered cleanly on `orgs_privacyerasure` and `orgs_accounterasure`."""
        from apps.orgs.account_erasure_services import (
            AccountAbsenceProof,
            AccountErasureAdapter,
            AccountErasureScope,
            advance_account_erasure,
            begin_account_erasure,
        )
        from apps.orgs.erasure_services import (
            AbsenceProof,
            ErasureAdapter,
            ErasureScope,
            advance_erasure,
            begin_erasure,
            database_now,
        )
        from apps.outbox.passport_erasure import PassportAccountOutboxErasureAdapter
        from django.db import IntegrityError, connection, transaction
        from django.utils import timezone
        from test_core_erasure import operator
        from test_customer_persistence_models import anchor_models, identity

        from services.identity.trusted_issuers import verify_configured_token

        class _OrgStubAdapter:
            revision = "eebilling-org-stub-v1"

            def __init__(self, domain: str) -> None:
                self.domain = domain

            def erase_and_verify(self, scope: ErasureScope) -> AbsenceProof:
                return AbsenceProof(
                    scope.request_id,
                    scope.organisation_id,
                    scope.cutoff_at,
                    self.domain,
                    scope.inventory_sha256,
                    "e" * 64,
                    self.revision,
                    database_now(),
                )

            def verify_proof(self, scope: ErasureScope, proof: AbsenceProof) -> bool:
                return proof.evidence_sha256 == "e" * 64

        class _AccountStubAdapter:
            revision = "eebilling-acc-stub-v1"

            def __init__(self, domain: str) -> None:
                self.domain = domain

            def erase_and_verify(self, scope: AccountErasureScope) -> AccountAbsenceProof:
                return AccountAbsenceProof(
                    scope.request_id,
                    scope.user_id,
                    scope.cutoff_at,
                    self.domain,
                    scope.inventory_sha256,
                    "f" * 64,
                    self.revision,
                    database_now(),
                )

            def verify_proof(self, scope: AccountErasureScope, proof: AccountAbsenceProof) -> bool:
                return proof.evidence_sha256 == "f" * 64

        w = ee_billing_pg_world
        internal_tok = "ee-erasure-internal-" + ("d" * 20)
        env = {
            "KODERA_EDITION": "enterprise",
            "KODERA_EE_INTERNAL_TOKEN": internal_tok,
        }
        router = EnterpriseBillingRouter()

        # Verify composable trigger inventory on `orgs_privacyerasure` and `orgs_accounterasure`
        with connection.cursor() as cur:
            cur.execute(
                "SELECT c.relname, t.tgname FROM pg_trigger t "
                "JOIN pg_class c ON c.oid = t.tgrelid "
                "WHERE c.relname IN ('orgs_privacyerasure', 'orgs_accounterasure') "
                "AND NOT t.tgisinternal ORDER BY c.relname, t.tgname"
            )
            trig_pairs = {(r[0], r[1]) for r in cur.fetchall()}
        assert ("orgs_privacyerasure", "aa_01_passport_erasure") in trig_pairs
        assert ("orgs_privacyerasure", "aa_02_ee_billing_erasure") in trig_pairs
        assert ("orgs_accounterasure", "aa_01_passport_erasure") in trig_pairs
        assert ("orgs_accounterasure", "aa_02_ee_billing_erasure") in trig_pairs

        # Seed a dedicated `cfo_owner` on `org_alpha` (so `org_alpha` has 2 owners and `cfo_owner`
        # can undergo account erasure without hitting last-owner guard), plus a `bravo_owner`.
        models = anchor_models()
        now = timezone.now()
        cfo_user = models.User.objects.create(
            email=f"cfo-{uuid.uuid4().hex[:6]}@alpha-corp.fr",
            display_name="Camille Alpha CFO",
        )
        cfo_sub = "sub-cfo-" + uuid.uuid4().hex[:8]
        identity(models, w.org_alpha, cfo_user, subject=cfo_sub)
        models.Membership.objects.create(
            user=cfo_user,
            organisation=w.org_alpha,
            role="org_owner",
            state="active",
            accepted_at=now,
        )
        cfo_token = w.mint_jwt(w.org_alpha.issuer, cfo_sub)

        bravo_owner = models.User.objects.create(
            email=f"owner-{uuid.uuid4().hex[:6]}@bravo-corp.fr",
            display_name="Bravo Owner",
        )
        bravo_sub = "sub-bravo-own-" + uuid.uuid4().hex[:8]
        identity(models, w.org_bravo, bravo_owner, subject=bravo_sub)
        models.Membership.objects.create(
            user=bravo_owner,
            organisation=w.org_bravo,
            role="org_owner",
            state="active",
            accepted_at=now,
        )
        bravo_owner_token = w.mint_jwt(w.org_bravo.issuer, bravo_sub)

        cfo_hdr = {"Authorization": f"Bearer {cfo_token}"}
        alpha_owner_hdr = {"Authorization": f"Bearer {w.alpha_owner_token}"}
        bravo_owner_hdr = {"Authorization": f"Bearer {bravo_owner_token}"}
        staff_hdr = {"Authorization": f"Bearer {w.staff_token}"}
        internal_hdr = {"X-Kodera-Internal-Token": internal_tok}

        # Seed warm-pool slots claimed by `org_alpha` and `org_bravo`
        rep = router.dispatch(
            "POST",
            "/api/v1/ee/billing/warm-pool/replenish",
            body=json.dumps({"region": "fr-par-priv", "profile_ref": "priv-v1"}).encode(),
            headers=staff_hdr,
            environ=env,
        )
        assert rep.status_code == 200
        slot_alpha = rep.json()["created_slots"][0]["slot_id"]
        slot_bravo = rep.json()["created_slots"][1]["slot_id"]
        router.warm_pool.mark_ready(slot_alpha)
        router.warm_pool.mark_ready(slot_bravo)

        def _make_po(org_id: str, hdr: dict[str, str], ref: str) -> str:
            res = router.dispatch(
                "POST",
                "/api/v1/ee/billing/purchase-orders",
                body=json.dumps(
                    {
                        "organisation_id": org_id,
                        "customer_po_reference": ref,
                        "plan_code": "sovereign",
                        "billing_months": 12,
                        "committed_seats": 40,
                        "committed_storage_gb": 200,
                        "subtotal_excl_vat_minor": 600_000,
                    }
                ).encode(),
                headers=staff_hdr,
                environ=env,
            )
            assert res.status_code == 201
            return str(res.json()["po_id"])

        _ = _make_po(w.org_alpha_id, cfo_hdr, "BDC-ALPHA-DRAFT-PII")
        po_issued_id = _make_po(w.org_alpha_id, cfo_hdr, "BDC-ALPHA-ISSUED-PII")
        po_cs_id = _make_po(w.org_alpha_id, cfo_hdr, "BDC-ALPHA-CS-JOHN-DOE")
        po_paid_id = _make_po(w.org_alpha_id, cfo_hdr, "BDC-ALPHA-PAID-JOHN-DOE")
        po_bravo_id = _make_po(w.org_bravo_id, bravo_owner_hdr, "BDC-BRAVO-LIVE-01")

        for pid in (po_issued_id, po_cs_id, po_paid_id, po_bravo_id):
            assert (
                router.dispatch(
                    "POST",
                    f"/api/v1/ee/billing/purchase-orders/{pid}/transitions",
                    body=json.dumps({"action": "issue"}).encode(),
                    headers=staff_hdr,
                    environ=env,
                ).status_code
                == 200
            )

        signatory_with_email = f"Camille CFO <{cfo_user.email}>"
        for pid in (po_cs_id, po_paid_id):
            assert (
                router.dispatch(
                    "POST",
                    f"/api/v1/ee/billing/purchase-orders/{pid}/transitions",
                    body=json.dumps(
                        {"action": "countersign", "signatory": signatory_with_email}
                    ).encode(),
                    headers=cfo_hdr,
                    environ=env,
                ).status_code
                == 200
            )
        assert (
            router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{po_bravo_id}/transitions",
                body=json.dumps({"action": "countersign", "signatory": "Bravo CFO"}).encode(),
                headers=bravo_owner_hdr,
                environ=env,
            ).status_code
            == 200
        )

        inv_paid = self._seed_core_invoice(
            organisation_id=w.org_alpha_id,
            number="KODERA-2026-00991",
            subtotal_excl_vat_minor=600_000,
            vat_amount_minor=120_000,
        )
        self._settle_core_invoice(inv_paid, payment_ref="WIRE-PRIV-991")
        assert (
            router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{po_paid_id}/transitions",
                body=json.dumps(
                    {"action": "invoice", "invoice_ref": "INV-KODERA-2026-00991"}
                ).encode(),
                headers=staff_hdr,
                environ=env,
            ).status_code
            == 200
        )
        assert (
            router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{po_paid_id}/transitions",
                body=json.dumps(
                    {
                        "action": "pay",
                        "invoice_ref": "INV-KODERA-2026-00991",
                        "payment_ref": "WIRE-PRIV-991",
                        "amount_paid_minor": 720_000,
                    }
                ).encode(),
                headers=internal_hdr,
                environ=env,
            ).status_code
            == 200
        )

        inv_bravo_priv = self._seed_core_invoice(
            organisation_id=w.org_bravo_id,
            number="KODERA-2026-00992",
            subtotal_excl_vat_minor=600_000,
            vat_amount_minor=120_000,
        )
        self._settle_core_invoice(inv_bravo_priv, payment_ref="WIRE-PRIV-992")
        assert (
            router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{po_bravo_id}/transitions",
                body=json.dumps(
                    {"action": "invoice", "invoice_ref": "INV-KODERA-2026-00992"}
                ).encode(),
                headers=staff_hdr,
                environ=env,
            ).status_code
            == 200
        )
        assert (
            router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{po_bravo_id}/transitions",
                body=json.dumps(
                    {
                        "action": "pay",
                        "invoice_ref": "INV-KODERA-2026-00992",
                        "payment_ref": "WIRE-PRIV-992",
                        "amount_paid_minor": 720_000,
                    }
                ).encode(),
                headers=internal_hdr,
                environ=env,
            ).status_code
            == 200
        )

        assert (
            router.dispatch(
                "POST",
                "/api/v1/ee/billing/warm-pool/claim",
                body=json.dumps(
                    {
                        "organisation_id": w.org_alpha_id,
                        "checkout_id": po_paid_id,
                        "region": "fr-par-priv",
                        "profile_ref": "priv-v1",
                    }
                ).encode(),
                headers={**cfo_hdr, "Idempotency-Key": "idem-priv-alpha-01"},
                environ=env,
            ).status_code
            == 201
        )
        assert (
            router.dispatch(
                "POST",
                "/api/v1/ee/billing/warm-pool/claim",
                body=json.dumps(
                    {
                        "organisation_id": w.org_bravo_id,
                        "checkout_id": po_bravo_id,
                        "region": "fr-par-priv",
                        "profile_ref": "priv-v1",
                    }
                ).encode(),
                headers={**bravo_owner_hdr, "Idempotency-Key": "bbbb-bbbb-0001"},
                environ=env,
            ).status_code
            == 201
        )

        # --- 1. Account Privacy Erasure on `cfo_user` ---
        staff_actor = operator()
        now_epoch = int(database_now().timestamp())
        from dataclasses import replace

        from django.conf import settings as dj_settings

        raw_cfo_jwt = w.mint_jwt(w.org_alpha.issuer, cfo_sub)
        verified_raw, _ = verify_configured_token(
            raw_cfo_jwt,
            trusted=dj_settings.KODERA_AUTH_TRUST,
        )
        verified_cfo = replace(
            verified_raw,
            auth_time=now_epoch,
            expires_at=now_epoch + 600,
        )

        acc_erasure = begin_account_erasure(
            verified=verified_cfo,
            confirmation="delete",
            instruction_ref="DEL-2001",
            instruction_sha256="3" * 64,
            purge_not_before=database_now(),
            actor_identity_id=staff_actor.id,
        )
        assert set(acc_erasure.inventory["ee_billing_scrub_po_ids"]) == {po_cs_id, po_paid_id}

        acc_adapters: dict[str, AccountErasureAdapter] = {}
        for d in acc_erasure.inventory["required_domains"]:
            if d == "account_message_outbox":
                acc_adapters[str(d)] = PassportAccountOutboxErasureAdapter()
            else:
                acc_adapters[str(d)] = _AccountStubAdapter(str(d))
        acc_done = advance_account_erasure(acc_erasure.id, acc_adapters)
        assert acc_done["complete"] is True
        assert acc_done["counts"]["ee_billing_signatories_scrubbed"] == 2

        for pid in (po_cs_id, po_paid_id):
            po_after_acc = router.purchase_orders.get(pid, environ=env)
            assert po_after_acc.countersigned_by == f"erased:{cfo_user.id}"

        # Erased `cfo_token` is immediately refused (403) on all EE billing routes
        assert (
            router.dispatch(
                "GET",
                f"/api/v1/ee/billing/purchase-orders/{po_paid_id}",
                headers=cfo_hdr,
                environ=env,
            ).status_code
            == 403
        )

        # --- 2. Organisation Privacy Erasure on `org_alpha` ---
        org_erasure = begin_erasure(
            organisation_id=w.org_alpha.id,
            instruction_ref="DEL-2002",
            instruction_sha256="4" * 64,
            purge_not_before=database_now(),
            actor_identity_id=staff_actor.id,
        )
        assert set(org_erasure.inventory["ee_billing_retained_po_ids"]) == {po_cs_id, po_paid_id}
        assert org_erasure.inventory["ee_billing_ephemeral_po_count"] == 2

        # Claimed warm-pool slot for `org_alpha` is immediately evicted & released at cutoff
        with connection.cursor() as cur:
            cur.execute(
                "SELECT state, claimed_by_organisation_id, unhealthy_reason"
                " FROM ee_billing_warm_pool_slots WHERE slot_id = %s",
                [slot_alpha],
            )
            assert cur.fetchone() == ("evicted", None, "organisation_erasure")

        # Post-cutoff mutations for `org_alpha` fail closed across customer (403) & internal/staff (409)
        assert (
            router.dispatch(
                "POST",
                "/api/v1/ee/billing/purchase-orders",
                body=json.dumps(
                    {
                        "organisation_id": w.org_alpha_id,
                        "customer_po_reference": "BDC-POST-CUTOFF",
                        "plan_code": "sovereign",
                        "billing_months": 12,
                        "committed_seats": 30,
                        "committed_storage_gb": 100,
                        "subtotal_excl_vat_minor": 500_000,
                    }
                ).encode(),
                headers=alpha_owner_hdr,
                environ=env,
            ).status_code
            == 403
        )
        assert (
            router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{po_cs_id}/transitions",
                body=json.dumps(
                    {"action": "invoice", "invoice_ref": "INV-KODERA-2026-00992"}
                ).encode(),
                headers=internal_hdr,
                environ=env,
            ).status_code
            == 409
        )
        # Direct SQL DELETE of accounting PO is refused (`23514`)
        with pytest.raises(IntegrityError), transaction.atomic(), connection.cursor() as cur:
            cur.execute("DELETE FROM ee_billing_purchase_orders WHERE po_id = %s", [po_paid_id])

        org_adapters: dict[str, ErasureAdapter] = {
            str(d): _OrgStubAdapter(str(d)) for d in org_erasure.inventory["required_domains"]
        }
        org_done = advance_erasure(org_erasure.id, org_adapters)
        assert org_done["complete"] is True
        assert org_done["counts"]["ee_billing_ephemeral_pos_deleted"] == 2
        assert org_done["counts"]["ee_billing_retained_pos_scrubbed"] == 2

        with connection.cursor() as cur:
            cur.execute(
                "SELECT po_id, po_number, state, countersigned_by, customer_po_reference,"
                " pii_scrubbed_at IS NOT NULL, total_incl_vat_minor"
                " FROM ee_billing_purchase_orders WHERE organisation_id = %s ORDER BY po_id",
                [w.org_alpha_id],
            )
            alpha_rows = cur.fetchall()
        assert [r[0] for r in alpha_rows] == sorted([po_cs_id, po_paid_id])
        for _, po_num, st, sig, cust_ref, is_scrubbed, total_minor in alpha_rows:
            assert st in {"countersigned", "paid"}
            assert sig == "erased"
            assert cust_ref == f"REDACTED-{po_num}"
            assert is_scrubbed is True
            assert total_minor == 720_000

        # Sibling `org_bravo` PO and claimed warm-pool slot remain 100% intact!
        bravo_po = router.purchase_orders.get(po_bravo_id, environ=env)
        assert bravo_po.customer_po_reference == "BDC-BRAVO-LIVE-01"
        with connection.cursor() as cur:
            cur.execute(
                "SELECT state, claimed_by_organisation_id FROM ee_billing_warm_pool_slots"
                " WHERE slot_id = %s",
                [slot_bravo],
            )
            assert cur.fetchone() == ("claimed", w.org_bravo_id)

    def test_restricted_role_staff_capabilities_countersign_ownership_and_held_downgrade_fence(
        self,
        ee_billing_pg_world,
        monkeypatch,
    ) -> None:
        """Prove over real Django HTTP (`Client()`) under restricted `kodera_api` (`SET ROLE`):
        1. `staff_support` and `staff_security` are refused (`403`) on every EE billing mutator
           (`replenish`, `evict`, `claim`, `purchase-orders`, `issue`, `countersign`, `invoice`,
           `pay`, `expire`, and unknown transition action).
        2. `staff_support` is admitted (`200`) on governed commercial reads (`GET /plans`,
           `POST /quotes`, `GET /warm-pool`, `GET /purchase-orders/{po_id}`,
           `POST /purchase-orders/{po_id}/commitment-check`), whereas `staff_security` receives
           `403` on all 5 read routes.
        3. `staff_operator` and `internal` succeed on operator/commercial mutations, while BOTH
           receive `403` on customer-only `countersign`.
        4. Held-fence role downgrade race: revoking `staff_operator` on `conn2` while leaving
           `staff_support` active causes pre-admitted mutating dispatches to fail closed (`403`)
           inside `_acquire_ee_caller_fence` while read-only inspection (`GET /warm-pool`) stays
           admitted (`200`)."""
        import psycopg
        from apps.identity.models import Identity, StaffRole, User
        from django.db import connection
        from django.test import Client
        from test_intake_writer_role import INSUFFICIENT_PRIVILEGE, acting_as, current_user, refused

        from core.db.api_database_boundary import assert_writer_grants
        from core.db.api_writer_role import grant_statements
        from ee.billing.api import authenticate_bearer_header

        w = ee_billing_pg_world
        internal_tok = "ee-role-internal-" + ("a" * 20)
        monkeypatch.setenv("KODERA_EDITION", "enterprise")
        monkeypatch.setenv("KODERA_EE_INTERNAL_TOKEN", internal_tok)
        monkeypatch.setitem(connection.settings_dict, "CONN_MAX_AGE", 60)
        env = {
            "KODERA_EDITION": "enterprise",
            "KODERA_EE_INTERNAL_TOKEN": internal_tok,
        }

        def _make_staff_principal(roles: tuple[str, ...], tag: str) -> tuple[Identity, str]:
            u = User.objects.create(
                email=f"{tag}-{uuid.uuid4().hex[:6]}@staff.test",
                enabled=True,
            )
            sub = f"staff-{tag}-" + uuid.uuid4().hex[:8]
            ident = Identity.objects.create(
                user=u,
                organisation=None,
                issuer=w.staff_id.issuer,
                realm="kodera-staff",
                subject=sub,
                email=u.email,
                enabled=True,
            )
            for r in roles:
                StaffRole.objects.create(identity=ident, realm="kodera-staff", role=r)
            tok = w.mint_jwt(w.staff_id.issuer, sub, amr=["pwd", "otp"])
            return ident, tok

        _, support_token = _make_staff_principal(("staff_support",), "support")
        _, security_token = _make_staff_principal(("staff_security",), "security")
        dual_id, dual_token = _make_staff_principal(("staff_operator", "staff_support"), "dual")

        # Pre-seed Core ledger invoice + payment as schema owner (`kodera_api` holds SELECT only)
        inv_997 = self._seed_core_invoice(
            organisation_id=w.org_alpha_id,
            number="KODERA-2026-00997",
            subtotal_excl_vat_minor=600_000,
            vat_amount_minor=120_000,
        )
        self._settle_core_invoice(inv_997, payment_ref="WIRE-ROLE-997")

        role = f"ee_role_matrix_{uuid.uuid4().hex[:10]}"
        with connection.cursor() as cursor:
            cursor.execute(
                f'CREATE ROLE "{role}" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
            )
            for statement in grant_statements(role):
                cursor.execute(statement)
            assert_writer_grants(cursor, role)

        client = Client()
        seed_router = EnterpriseBillingRouter()

        try:
            with acting_as(role):
                assert current_user() == role

                # Operator replenishes warm pool; mark 1 slot ready and 1 slot unhealthy
                r_rep_op = client.post(
                    "/api/v1/ee/billing/warm-pool/replenish",
                    data=json.dumps({"region": "fr-par-cap", "profile_ref": "cap-v1"}).encode(),
                    content_type="application/json",
                    HTTP_AUTHORIZATION=f"Bearer {w.staff_token}",
                )
                assert r_rep_op.status_code == 200
                slot_ready = r_rep_op.json()["created_slots"][0]["slot_id"]
                slot_bad = r_rep_op.json()["created_slots"][1]["slot_id"]
                seed_router.warm_pool.mark_ready(slot_ready)
                seed_router.warm_pool.mark_unhealthy(slot_bad, reason="health_probe_failed")

                # Operator creates 3 POs (`po_draft`, `po_issued`, `po_cs`) for transition matrix
                def _post_po(ref: str, auth_hdr: dict[str, str]) -> str:
                    res = client.post(
                        "/api/v1/ee/billing/purchase-orders",
                        data=json.dumps(
                            {
                                "organisation_id": w.org_alpha_id,
                                "customer_po_reference": ref,
                                "plan_code": "sovereign",
                                "billing_months": 12,
                                "committed_seats": 40,
                                "committed_storage_gb": 200,
                                "subtotal_excl_vat_minor": 600_000,
                            }
                        ).encode("utf-8"),
                        content_type="application/json",
                        headers=auth_hdr,
                    )
                    assert res.status_code == 201
                    return str(res.json()["po_id"])

                op_hdr = {"Authorization": f"Bearer {w.staff_token}"}
                int_hdr = {"X-Kodera-Internal-Token": internal_tok}
                owner_hdr = {"Authorization": f"Bearer {w.alpha_owner_token}"}
                sup_hdr = {"Authorization": f"Bearer {support_token}"}
                sec_hdr = {"Authorization": f"Bearer {security_token}"}

                po_draft = _post_po("BDC-CAP-DRAFT-01", op_hdr)
                po_issued = _post_po("BDC-CAP-ISSUED-01", int_hdr)
                po_cs = _post_po("BDC-CAP-CS-01", op_hdr)

                assert (
                    client.post(
                        f"/api/v1/ee/billing/purchase-orders/{po_issued}/transitions",
                        data=json.dumps({"action": "issue"}).encode("utf-8"),
                        content_type="application/json",
                        headers=op_hdr,
                    ).status_code
                    == 200
                )
                assert (
                    client.post(
                        f"/api/v1/ee/billing/purchase-orders/{po_cs}/transitions",
                        data=json.dumps({"action": "issue"}).encode("utf-8"),
                        content_type="application/json",
                        headers=int_hdr,
                    ).status_code
                    == 200
                )

                # Staff operator & internal token are BOTH refused (403) on customer `countersign`!
                for non_customer_hdr in (op_hdr, int_hdr, sup_hdr, sec_hdr):
                    r_cs_denied = client.post(
                        f"/api/v1/ee/billing/purchase-orders/{po_cs}/transitions",
                        data=json.dumps(
                            {"action": "countersign", "signatory": "Non-Customer Attempt"}
                        ).encode("utf-8"),
                        content_type="application/json",
                        headers=non_customer_hdr,
                    )
                    assert r_cs_denied.status_code == 403

                # Customer `org_owner` countersigns `po_cs` cleanly (200), without leaking user UUID
                r_cs_ok = client.post(
                    f"/api/v1/ee/billing/purchase-orders/{po_cs}/transitions",
                    data=json.dumps(
                        {"action": "countersign", "signatory": "Alpha Signatory"}
                    ).encode("utf-8"),
                    content_type="application/json",
                    headers=owner_hdr,
                )
                assert r_cs_ok.status_code == 200
                assert "countersigned_by_user_id" not in r_cs_ok.json()

                # 1. `staff_support` AND `staff_security` -> 403 on EVERY mutator route & action
                for denied_hdr in (sup_hdr, sec_hdr):
                    assert (
                        client.post(
                            "/api/v1/ee/billing/warm-pool/replenish",
                            data=json.dumps(
                                {"region": "fr-par-cap", "profile_ref": "cap-v1"}
                            ).encode("utf-8"),
                            content_type="application/json",
                            headers=denied_hdr,
                        ).status_code
                        == 403
                    )
                    assert (
                        client.post(
                            "/api/v1/ee/billing/warm-pool/evict",
                            data=json.dumps(
                                {"region": "fr-par-cap", "profile_ref": "cap-v1"}
                            ).encode("utf-8"),
                            content_type="application/json",
                            headers=denied_hdr,
                        ).status_code
                        == 403
                    )
                    assert (
                        client.post(
                            "/api/v1/ee/billing/warm-pool/claim",
                            data=json.dumps(
                                {
                                    "organisation_id": w.org_alpha_id,
                                    "checkout_id": "cs_cap_denied_01",
                                    "region": "fr-par-cap",
                                    "profile_ref": "cap-v1",
                                }
                            ).encode("utf-8"),
                            content_type="application/json",
                            headers={**denied_hdr, "Idempotency-Key": "aaaa-aaaa-9001"},
                        ).status_code
                        == 403
                    )
                    assert (
                        client.post(
                            "/api/v1/ee/billing/purchase-orders",
                            data=json.dumps(
                                {
                                    "organisation_id": w.org_alpha_id,
                                    "customer_po_reference": "BDC-DENIED",
                                    "plan_code": "sovereign",
                                    "billing_months": 12,
                                    "committed_seats": 40,
                                    "committed_storage_gb": 200,
                                    "subtotal_excl_vat_minor": 600_000,
                                }
                            ).encode("utf-8"),
                            content_type="application/json",
                            headers=denied_hdr,
                        ).status_code
                        == 403
                    )
                    for target_po, payload in (
                        (po_draft, {"action": "issue"}),
                        (po_issued, {"action": "expire"}),
                        (
                            po_cs,
                            {"action": "invoice", "invoice_ref": "INV-KODERA-2026-00997"},
                        ),
                        (
                            po_cs,
                            {
                                "action": "pay",
                                "invoice_ref": "INV-KODERA-2026-00997",
                                "payment_ref": "WIRE-ROLE-997",
                                "amount_paid_minor": 720_000,
                            },
                        ),
                        (po_draft, {"action": "unknown_action"}),
                    ):
                        assert (
                            client.post(
                                f"/api/v1/ee/billing/purchase-orders/{target_po}/transitions",
                                data=json.dumps(payload).encode("utf-8"),
                                content_type="application/json",
                                headers=denied_hdr,
                            ).status_code
                            == 403
                        ), (target_po, payload["action"])

                # 2. `staff_support` -> 200 on all 5 read routes; `staff_security` -> 403 on all 5!
                read_calls = [
                    ("GET", "/api/v1/ee/billing/plans", None),
                    (
                        "POST",
                        "/api/v1/ee/billing/quotes",
                        {
                            "organisation_id": w.org_alpha_id,
                            "plan_code": "sovereign",
                            "seats": 40,
                        },
                    ),
                    ("GET", "/api/v1/ee/billing/warm-pool", None),
                    ("GET", f"/api/v1/ee/billing/purchase-orders/{po_cs}", None),
                    (
                        "POST",
                        f"/api/v1/ee/billing/purchase-orders/{po_cs}/commitment-check",
                        {"active_seats": 20, "used_storage_gb": 100},
                    ),
                ]
                for method, path, body_obj in read_calls:
                    for caller_hdr, expected_code in (
                        (sup_hdr, 200),
                        (op_hdr, 200),
                        (sec_hdr, 403),
                    ):
                        if method == "GET":
                            resp = client.get(path, headers=caller_hdr)
                        else:
                            resp = client.post(
                                path,
                                data=json.dumps(body_obj).encode("utf-8"),
                                content_type="application/json",
                                headers=caller_hdr,
                            )
                        assert resp.status_code == expected_code, (method, path, expected_code)

                # 3. `staff_operator` & `internal` succeed on `evict`, `claim`, `invoice`, `pay`, `expire`
                r_evict = client.post(
                    "/api/v1/ee/billing/warm-pool/evict",
                    data=json.dumps({"region": "fr-par-cap", "profile_ref": "cap-v1"}).encode(
                        "utf-8"
                    ),
                    content_type="application/json",
                    headers=op_hdr,
                )
                assert r_evict.status_code == 200
                assert r_evict.json()["count"] == 1
                assert r_evict.json()["evicted_slots"][0]["slot_id"] == slot_bad

                r_claim_op = client.post(
                    "/api/v1/ee/billing/warm-pool/claim",
                    data=json.dumps(
                        {
                            "organisation_id": w.org_alpha_id,
                            "checkout_id": "cs_cap_op_01",
                            "region": "fr-par-cap",
                            "profile_ref": "cap-v1",
                        }
                    ).encode("utf-8"),
                    content_type="application/json",
                    headers={**op_hdr, "Idempotency-Key": "aaaa-aaaa-9002"},
                )
                assert r_claim_op.status_code == 201

                assert (
                    client.post(
                        f"/api/v1/ee/billing/purchase-orders/{po_cs}/transitions",
                        data=json.dumps(
                            {"action": "invoice", "invoice_ref": "INV-KODERA-2026-00997"}
                        ).encode("utf-8"),
                        content_type="application/json",
                        headers=op_hdr,
                    ).status_code
                    == 200
                )
                assert (
                    client.post(
                        f"/api/v1/ee/billing/purchase-orders/{po_cs}/transitions",
                        data=json.dumps(
                            {
                                "action": "pay",
                                "invoice_ref": "INV-KODERA-2026-00997",
                                "payment_ref": "WIRE-ROLE-997",
                                "amount_paid_minor": 720_000,
                            }
                        ).encode("utf-8"),
                        content_type="application/json",
                        headers=int_hdr,
                    ).status_code
                    == 200
                )
                assert (
                    client.post(
                        f"/api/v1/ee/billing/purchase-orders/{po_issued}/transitions",
                        data=json.dumps({"action": "expire"}).encode("utf-8"),
                        content_type="application/json",
                        headers=op_hdr,
                    ).status_code
                    == 200
                )

                # Confirm connection NEVER left `SET ROLE` across all `Client()` requests,
                # and `pii_scrubbed_at` stays strictly ungranted to `kodera_api`!
                assert current_user() == role
                assert (
                    refused(
                        "UPDATE ee_billing_purchase_orders SET pii_scrubbed_at = clock_timestamp()"
                    )
                    == INSUFFICIENT_PRIVILEGE
                )

                # 4. Held-fence role downgrade race: pre-admit `dual_principal` holding BOTH
                #    `staff_operator` and `staff_support`, then revoke ONLY `staff_operator` on
                #    `conn2` -> mutating dispatches fail closed (403) inside `_acquire_ee_caller_fence`,
                #    while read-only `GET /warm-pool` remains admitted (200)!
                dual_principal = authenticate_bearer_header(
                    {"authorization": f"Bearer {dual_token}"}, environ=env
                )
                assert dual_principal.staff_roles == frozenset({"staff_operator", "staff_support"})
                dual_router = EnterpriseBillingRouter(authenticator=lambda _h: dual_principal)

                cfg = connection.settings_dict
                with psycopg.connect(
                    host=cfg["HOST"],
                    port=cfg["PORT"],
                    dbname=cfg["NAME"],
                    user=cfg["USER"],
                    password=cfg["PASSWORD"],
                    autocommit=True,
                ) as conn2:
                    conn2.execute(
                        "UPDATE identity_staffrole SET revoked_at = clock_timestamp()"
                        " WHERE identity_id = %s AND role = 'staff_operator'",
                        [dual_id.id],
                    )

                assert (
                    dual_router.dispatch(
                        "POST",
                        "/api/v1/ee/billing/warm-pool/replenish",
                        body=json.dumps({"region": "fr-par-cap", "profile_ref": "cap-v1"}).encode(
                            "utf-8"
                        ),
                        headers={"Authorization": "Bearer pre-verified"},
                        environ=env,
                    ).status_code
                    == 403
                )
                assert (
                    dual_router.dispatch(
                        "POST",
                        "/api/v1/ee/billing/warm-pool/evict",
                        body=json.dumps({"region": "fr-par-cap", "profile_ref": "cap-v1"}).encode(
                            "utf-8"
                        ),
                        headers={"Authorization": "Bearer pre-verified"},
                        environ=env,
                    ).status_code
                    == 403
                )
                assert (
                    dual_router.dispatch(
                        "POST",
                        f"/api/v1/ee/billing/purchase-orders/{po_draft}/transitions",
                        body=json.dumps({"action": "issue"}).encode("utf-8"),
                        headers={"Authorization": "Bearer pre-verified"},
                        environ=env,
                    ).status_code
                    == 403
                )
                assert seed_router.purchase_orders.get(po_draft, environ=env).state == "draft"
                assert (
                    dual_router.dispatch(
                        "GET",
                        "/api/v1/ee/billing/warm-pool",
                        headers={"Authorization": "Bearer pre-verified"},
                        environ=env,
                    ).status_code
                    == 200
                )
        finally:
            with connection.cursor() as cursor:
                cursor.execute("RESET ROLE")
                cursor.execute(f'DROP OWNED BY "{role}"')
                cursor.execute(f'DROP ROLE "{role}"')

    def test_name_only_signatory_account_erasure_and_same_name_person_isolation(
        self,
        ee_billing_pg_world,
    ) -> None:
        """Prove `countersigned_by_user_id` signatory ownership invariants:
        1. A customer signatory countersigning with a plain display name (`"Camille Martin"`)
           whose email (`acct-7741@opaque.example`) and OIDC subject (`sub-opaque-7741`) share
           ZERO tokens with the signatory string is still scrubbed (`erased:<person_p.id>`) and
           reaches `complete=True` on account erasure via `countersigned_by_user_id`.
        2. An independent second customer (`person_q`, `acct-8892@opaque.example`) who ALSO
           countersigned another PO with the exact same string `"Camille Martin"` is 100%
           untouched when `person_p` erases their account.
        3. Legacy `countersigned_by_user_id IS NULL` rows whose `countersigned_by` embeds
           `person_p`'s identifier continue to be scrubbed by the NULL-owner fallback, while
           rows bound to `person_q` (`countersigned_by_user_id = person_q.id`) are NEVER matched
           even if their `countersigned_by` text happens to mention `person_p`'s email."""
        from dataclasses import replace

        from apps.orgs.account_erasure_services import (
            AccountAbsenceProof,
            AccountErasureAdapter,
            AccountErasureScope,
            advance_account_erasure,
            begin_account_erasure,
        )
        from apps.orgs.erasure_services import database_now
        from apps.outbox.passport_erasure import PassportAccountOutboxErasureAdapter
        from django.conf import settings as dj_settings
        from django.db import connection
        from django.utils import timezone
        from test_core_erasure import operator
        from test_customer_persistence_models import anchor_models, identity

        from services.identity.trusted_issuers import verify_configured_token

        class _AccountStubAdapter:
            revision = "eebilling-acc-nameonly-stub-v1"

            def __init__(self, domain: str) -> None:
                self.domain = domain

            def erase_and_verify(self, scope: AccountErasureScope) -> AccountAbsenceProof:
                return AccountAbsenceProof(
                    scope.request_id,
                    scope.user_id,
                    scope.cutoff_at,
                    self.domain,
                    scope.inventory_sha256,
                    "f" * 64,
                    self.revision,
                    database_now(),
                )

            def verify_proof(self, scope: AccountErasureScope, proof: AccountAbsenceProof) -> bool:
                return proof.evidence_sha256 == "f" * 64

        w = ee_billing_pg_world
        models = anchor_models()
        now = timezone.now()
        env = {"KODERA_EDITION": "enterprise"}
        router = EnterpriseBillingRouter()

        person_p = models.User.objects.create(
            email="acct-7741@opaque.example",
            display_name="Opaque Account 7741",
        )
        sub_p = "sub-opaque-7741-" + uuid.uuid4().hex[:6]
        identity(models, w.org_alpha, person_p, subject=sub_p)
        models.Membership.objects.create(
            user=person_p,
            organisation=w.org_alpha,
            role="org_owner",
            state="active",
            accepted_at=now,
        )
        tok_p = w.mint_jwt(w.org_alpha.issuer, sub_p)
        hdr_p = {"Authorization": f"Bearer {tok_p}"}

        person_q = models.User.objects.create(
            email="acct-8892@opaque.example",
            display_name="Opaque Account 8892",
        )
        sub_q = "sub-opaque-8892-" + uuid.uuid4().hex[:6]
        identity(models, w.org_alpha, person_q, subject=sub_q)
        models.Membership.objects.create(
            user=person_q,
            organisation=w.org_alpha,
            role="org_owner",
            state="active",
            accepted_at=now,
        )
        tok_q = w.mint_jwt(w.org_alpha.issuer, sub_q)
        hdr_q = {"Authorization": f"Bearer {tok_q}"}

        def _create_and_countersign(hdr: dict[str, str], ref: str, sig: str) -> str:
            staff_hdr_local = {"Authorization": f"Bearer {w.staff_token}"}
            r_new = router.dispatch(
                "POST",
                "/api/v1/ee/billing/purchase-orders",
                body=json.dumps(
                    {
                        "organisation_id": w.org_alpha_id,
                        "customer_po_reference": ref,
                        "plan_code": "sovereign",
                        "billing_months": 12,
                        "committed_seats": 30,
                        "committed_storage_gb": 100,
                        "subtotal_excl_vat_minor": 500_000,
                    }
                ).encode("utf-8"),
                headers=staff_hdr_local,
                environ=env,
            )
            assert r_new.status_code == 201
            pid = str(r_new.json()["po_id"])
            assert "countersigned_by_user_id" not in r_new.json()
            assert (
                router.dispatch(
                    "POST",
                    f"/api/v1/ee/billing/purchase-orders/{pid}/transitions",
                    body=json.dumps({"action": "issue"}).encode("utf-8"),
                    headers=staff_hdr_local,
                    environ=env,
                ).status_code
                == 200
            )
            r_cs = router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{pid}/transitions",
                body=json.dumps({"action": "countersign", "signatory": sig}).encode("utf-8"),
                headers=hdr,
                environ=env,
            )
            assert r_cs.status_code == 200
            assert "countersigned_by_user_id" not in r_cs.json()
            return pid

        # Both `person_p` and `person_q` countersign with plain display name `"Camille Martin"`
        po_p = _create_and_countersign(hdr_p, "BDC-NAMEONLY-P-01", "Camille Martin")
        po_q = _create_and_countersign(hdr_q, "BDC-NAMEONLY-Q-01", "Camille Martin")
        # Even if `person_q`'s signatory label embeds `person_p`'s email, `countersigned_by_user_id = person_q.id` protects it!
        po_q_mention = _create_and_countersign(
            hdr_q, "BDC-NAMEONLY-Q-02", f"Proxy for <{person_p.email}>"
        )
        # Legacy NULL-owner row referencing `person_p`'s email
        po_legacy = _create_and_countersign(
            hdr_p, "BDC-LEGACY-NULL-01", f"Legacy Signer <{person_p.email}>"
        )
        with connection.cursor() as cur:
            cur.execute(
                "UPDATE ee_billing_purchase_orders SET countersigned_by_user_id = NULL"
                " WHERE po_id = %s",
                [po_legacy],
            )
            cur.execute(
                "SELECT po_id, countersigned_by_user_id FROM ee_billing_purchase_orders"
                " WHERE po_id = ANY(%s)",
                [[po_p, po_q, po_q_mention, po_legacy]],
            )
            owners = {row[0]: row[1] for row in cur.fetchall()}
        assert owners[po_p] == person_p.id
        assert owners[po_q] == person_q.id
        assert owners[po_q_mention] == person_q.id
        assert owners[po_legacy] is None

        # Erase `person_p`
        staff_actor = operator()
        now_epoch = int(database_now().timestamp())
        raw_p_jwt = w.mint_jwt(w.org_alpha.issuer, sub_p)
        verified_raw, _ = verify_configured_token(
            raw_p_jwt,
            trusted=dj_settings.KODERA_AUTH_TRUST,
        )
        verified_p = replace(verified_raw, auth_time=now_epoch, expires_at=now_epoch + 600)

        acc_erasure = begin_account_erasure(
            verified=verified_p,
            confirmation="delete",
            instruction_ref="DEL-3001",
            instruction_sha256="5" * 64,
            purge_not_before=database_now(),
            actor_identity_id=staff_actor.id,
        )
        assert set(acc_erasure.inventory["ee_billing_scrub_po_ids"]) == {po_p, po_legacy}

        acc_adapters: dict[str, AccountErasureAdapter] = {
            str(d): (
                PassportAccountOutboxErasureAdapter()
                if d == "account_message_outbox"
                else _AccountStubAdapter(str(d))
            )
            for d in acc_erasure.inventory["required_domains"]
        }
        acc_done = advance_account_erasure(acc_erasure.id, acc_adapters)
        assert acc_done["complete"] is True
        assert acc_done["counts"]["ee_billing_signatories_scrubbed"] == 2

        with connection.cursor() as cur:
            cur.execute(
                "SELECT po_id, countersigned_by, countersigned_by_user_id, pii_scrubbed_at IS NOT NULL"
                " FROM ee_billing_purchase_orders WHERE po_id = ANY(%s)",
                [[po_p, po_legacy, po_q, po_q_mention]],
            )
            after = {row[0]: (row[1], row[2], row[3]) for row in cur.fetchall()}

        assert after[po_p] == (f"erased:{person_p.id}", None, True)
        assert after[po_legacy] == (f"erased:{person_p.id}", None, True)
        assert after[po_q] == ("Camille Martin", person_q.id, False)
        assert after[po_q_mention] == (f"Proxy for <{person_p.email}>", person_q.id, False)

        # GET /purchase-orders/{id} never exposes `countersigned_by_user_id`
        r_get_q = router.dispatch(
            "GET",
            f"/api/v1/ee/billing/purchase-orders/{po_q}",
            headers=hdr_q,
            environ=env,
        )
        assert r_get_q.status_code == 200
        assert "countersigned_by_user_id" not in r_get_q.json()

    def test_stage4_bug_0058_0057_0059_and_e02_003_regressions(
        self,
        ee_billing_pg_world,
    ) -> None:
        """Regression suite for `BUG-0058` (`E02-003`), `BUG-0057`, and `BUG-0059` on PostgreSQL."""
        import psycopg
        from django.db import connection
        from django.utils import timezone
        from test_customer_persistence_models import anchor_models, identity

        w = ee_billing_pg_world
        env = {"KODERA_EDITION": "enterprise"}
        router = EnterpriseBillingRouter()
        staff_hdr = {"Authorization": f"Bearer {w.staff_token}"}
        alpha_owner_hdr = {"Authorization": f"Bearer {w.alpha_owner_token}"}
        alpha_billing_hdr = {"Authorization": f"Bearer {w.alpha_billing_token}"}
        alpha_admin_hdr = {"Authorization": f"Bearer {w.alpha_admin_token}"}

        models = anchor_models()
        now = timezone.now()
        bravo_owner = models.User.objects.create(
            email=f"bravo-s4-{uuid.uuid4().hex[:6]}@bravo-corp.fr",
            display_name="Bravo Owner S4",
        )
        bravo_sub = "sub-bravo-s4-" + uuid.uuid4().hex[:8]
        identity(models, w.org_bravo, bravo_owner, subject=bravo_sub)
        models.Membership.objects.create(
            user=bravo_owner,
            organisation=w.org_bravo,
            role="org_owner",
            state="active",
            accepted_at=now,
        )
        bravo_owner_hdr = {"Authorization": f"Bearer {w.mint_jwt(w.org_bravo.issuer, bravo_sub)}"}

        # --- BUG-0058 & E02-003: Quote override ceiling + server-authoritative catalog COGS/subtotal ---
        for bad_quote_override in (
            {"cogs_override_minor": 1},
            {"custom_net_excl_vat_minor": 999_999},
            {"discount_bps": 1000},
            {"vat_rate_bps": 0},
        ):
            r_override = router.dispatch(
                "POST",
                "/api/v1/ee/billing/quotes",
                body=json.dumps(
                    {
                        "organisation_id": w.org_alpha_id,
                        "plan_code": "sovereign",
                        "seats": 50,
                        **bad_quote_override,
                    }
                ).encode(),
                headers=alpha_owner_hdr,
                environ=env,
            )
            assert r_override.status_code == 403, bad_quote_override

        # Even staff cannot understate COGS below catalog COGS (`understated_cogs` -> 422)!
        r_understated_q = router.dispatch(
            "POST",
            "/api/v1/ee/billing/quotes",
            body=json.dumps(
                {
                    "plan_code": "sovereign",
                    "seats": 50,
                    "billing_cycle": "annual",
                    "cogs_override_minor": 100,
                }
            ).encode(),
            headers=staff_hdr,
            environ=env,
        )
        assert r_understated_q.status_code == 422

        # Staff creates PO omitting `subtotal_excl_vat_minor` -> computed from server catalog!
        r_catalog_po = router.dispatch(
            "POST",
            "/api/v1/ee/billing/purchase-orders",
            body=json.dumps(
                {
                    "organisation_id": w.org_alpha_id,
                    "customer_po_reference": "BDC-S4-CAT-01",
                    "plan_code": "sovereign",
                    "billing_months": 12,
                    "committed_seats": 25,
                    "committed_storage_gb": 100,
                }
            ).encode(),
            headers=staff_hdr,
            environ=env,
        )
        assert r_catalog_po.status_code == 201
        po_cat_id = str(r_catalog_po.json()["po_id"])
        assert po_cat_id.startswith("po_") and len(po_cat_id) == 39  # `po_<uuid7>` (`BUG-0059`)
        assert r_catalog_po.json()["subtotal_excl_vat_minor"] == 348_000
        assert r_catalog_po.json()["vat_amount_minor"] == 69_600
        assert r_catalog_po.json()["total_incl_vat_minor"] == 417_600

        # Staff PO with understated `estimated_cogs_minor` or below-44%-margin `subtotal_excl_vat_minor` -> 422!
        for bad_po_fields in (
            {"subtotal_excl_vat_minor": 120_000},
            {"subtotal_excl_vat_minor": 348_000, "estimated_cogs_minor": 100},
        ):
            r_bad_po = router.dispatch(
                "POST",
                "/api/v1/ee/billing/purchase-orders",
                body=json.dumps(
                    {
                        "organisation_id": w.org_alpha_id,
                        "customer_po_reference": "BDC-S4-BAD",
                        "plan_code": "sovereign",
                        "billing_months": 12,
                        "committed_seats": 25,
                        "committed_storage_gb": 100,
                        **bad_po_fields,
                    }
                ).encode(),
                headers=staff_hdr,
                environ=env,
            )
            assert r_bad_po.status_code == 422

        # --- BUG-0057: Unpaid warm-pool claim refused (403), paid claim capped at 1, release frees cap ---
        rep = router.dispatch(
            "POST",
            "/api/v1/ee/billing/warm-pool/replenish",
            body=json.dumps({"region": "fr-par-s4", "profile_ref": "s4-v1"}).encode(),
            headers=staff_hdr,
            environ=env,
        )
        assert rep.status_code == 200
        created_ids = [s["slot_id"] for s in rep.json()["created_slots"]]
        assert len(created_ids) >= 3
        for sid in created_ids:
            router.warm_pool.mark_ready(sid)

        # Unpaid `org_alpha` cannot claim warm-pool slot (`403`)!
        r_unpaid_claim = router.dispatch(
            "POST",
            "/api/v1/ee/billing/warm-pool/claim",
            body=json.dumps(
                {
                    "organisation_id": w.org_alpha_id,
                    "checkout_id": "cs_unpaid_s4",
                    "region": "fr-par-s4",
                    "profile_ref": "s4-v1",
                }
            ).encode(),
            headers={**alpha_owner_hdr, "Idempotency-Key": "idem-s4-shared-key"},
            environ=env,
        )
        assert r_unpaid_claim.status_code == 403

        # Staff issues `po_cat_id`; `org_billing` & `org_admin` get 403 on `countersign`, `org_owner` gets 200!
        assert (
            router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{po_cat_id}/transitions",
                body=json.dumps({"action": "issue"}).encode(),
                headers=staff_hdr,
                environ=env,
            ).status_code
            == 200
        )
        for denied_hdr in (alpha_billing_hdr, alpha_admin_hdr):
            assert (
                router.dispatch(
                    "POST",
                    f"/api/v1/ee/billing/purchase-orders/{po_cat_id}/transitions",
                    body=json.dumps(
                        {"action": "countersign", "signatory": "Billing Attempt"}
                    ).encode(),
                    headers=denied_hdr,
                    environ=env,
                ).status_code
                == 403
            )
        assert (
            router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{po_cat_id}/transitions",
                body=json.dumps({"action": "countersign", "signatory": "Alpha Owner"}).encode(),
                headers=alpha_owner_hdr,
                environ=env,
            ).status_code
            == 200
        )

        # Expiring a `countersigned` or `invoiced` PO is strictly forbidden (`409`) even for staff (`BUG-0058`)!
        assert (
            router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{po_cat_id}/transitions",
                body=json.dumps({"action": "expire"}).encode(),
                headers=staff_hdr,
                environ=env,
            ).status_code
            == 409
        )
        # `BUG-0057`: Unpaid `countersigned` Sovereign PO MUST be refused (`403`) on warm-pool claim!
        assert (
            router.dispatch(
                "POST",
                "/api/v1/ee/billing/warm-pool/claim",
                body=json.dumps(
                    {
                        "organisation_id": w.org_alpha_id,
                        "checkout_id": po_cat_id,
                        "region": "fr-par-s4",
                        "profile_ref": "s4-v1",
                    }
                ).encode(),
                headers={**alpha_owner_hdr, "Idempotency-Key": "idem-s4-unpaid-cs"},
                environ=env,
            ).status_code
            == 403
        )

        inv_s4 = self._seed_core_invoice(
            organisation_id=w.org_alpha_id,
            number="KODERA-2026-09401",
            subtotal_excl_vat_minor=348_000,
            vat_amount_minor=69_600,
        )
        assert (
            router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{po_cat_id}/transitions",
                body=json.dumps(
                    {"action": "invoice", "invoice_ref": "INV-KODERA-2026-09401"}
                ).encode(),
                headers=staff_hdr,
                environ=env,
            ).status_code
            == 200
        )
        assert (
            router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{po_cat_id}/transitions",
                body=json.dumps({"action": "expire"}).encode(),
                headers=staff_hdr,
                environ=env,
            ).status_code
            == 409
        )
        assert inv_s4.number == "KODERA-2026-09401"

        # `BUG-0057`: Unpaid `invoiced` Sovereign PO MUST ALSO be refused (`403`) on warm-pool claim!
        assert (
            router.dispatch(
                "POST",
                "/api/v1/ee/billing/warm-pool/claim",
                body=json.dumps(
                    {
                        "organisation_id": w.org_alpha_id,
                        "checkout_id": po_cat_id,
                        "region": "fr-par-s4",
                        "profile_ref": "s4-v1",
                    }
                ).encode(),
                headers={**alpha_owner_hdr, "Idempotency-Key": "idem-s4-unpaid-inv"},
                environ=env,
            ).status_code
            == 403
        )

        # `BUG-0057`: A settled (`paid`) NON-Enterprise `team` PO / Core invoice MUST ALSO return `403`!
        r_team_po = router.dispatch(
            "POST",
            "/api/v1/ee/billing/purchase-orders",
            body=json.dumps(
                {
                    "organisation_id": w.org_alpha_id,
                    "customer_po_reference": "BDC-TEAM-NON-EE-01",
                    "plan_code": "team",
                    "billing_months": 12,
                    "committed_seats": 25,
                    "committed_storage_gb": 50,
                }
            ).encode(),
            headers=staff_hdr,
            environ=env,
        )
        assert r_team_po.status_code == 201
        team_po_id = str(r_team_po.json()["po_id"])
        team_total = int(r_team_po.json()["total_incl_vat_minor"])
        team_sub = int(r_team_po.json()["subtotal_excl_vat_minor"])
        team_vat = int(r_team_po.json()["vat_amount_minor"])
        inv_team = self._seed_core_invoice(
            organisation_id=w.org_alpha_id,
            number="KODERA-2026-09402",
            subtotal_excl_vat_minor=team_sub,
            vat_amount_minor=team_vat,
        )
        self._settle_core_invoice(inv_team, payment_ref="WIRE-TEAM-9402")
        for hdr_t, pay_t in (
            (staff_hdr, {"action": "issue"}),
            (alpha_owner_hdr, {"action": "countersign", "signatory": "Alpha Owner"}),
            (staff_hdr, {"action": "invoice", "invoice_ref": "INV-KODERA-2026-09402"}),
            (
                staff_hdr,
                {
                    "action": "pay",
                    "invoice_ref": "INV-KODERA-2026-09402",
                    "payment_ref": "WIRE-TEAM-9402",
                    "amount_paid_minor": team_total,
                },
            ),
        ):
            assert (
                router.dispatch(
                    "POST",
                    f"/api/v1/ee/billing/purchase-orders/{team_po_id}/transitions",
                    body=json.dumps(pay_t).encode(),
                    headers=hdr_t,
                    environ=env,
                ).status_code
                == 200
            )
        for non_ee_ref in (team_po_id, "INV-KODERA-2026-09402", "WIRE-TEAM-9402"):
            assert (
                router.dispatch(
                    "POST",
                    "/api/v1/ee/billing/warm-pool/claim",
                    body=json.dumps(
                        {
                            "organisation_id": w.org_alpha_id,
                            "checkout_id": non_ee_ref,
                            "region": "fr-par-s4",
                            "profile_ref": "s4-v1",
                        }
                    ).encode(),
                    headers={**alpha_owner_hdr, "Idempotency-Key": f"idem-team-{non_ee_ref[-8:]}"},
                    environ=env,
                ).status_code
                == 403
            )

        # Settle `po_cat_id` (`sovereign`) to `paid` via `WIRE-S4-9401`
        self._settle_core_invoice(inv_s4, payment_ref="WIRE-S4-9401")
        assert (
            router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{po_cat_id}/transitions",
                body=json.dumps(
                    {
                        "action": "pay",
                        "invoice_ref": "INV-KODERA-2026-09401",
                        "payment_ref": "WIRE-S4-9401",
                        "amount_paid_minor": 417_600,
                    }
                ).encode(),
                headers=staff_hdr,
                environ=env,
            ).status_code
            == 200
        )

        # Even with a paid Sovereign PO, a fabricated `checkout_id` is refused (`403`)!
        r_fab_claim = router.dispatch(
            "POST",
            "/api/v1/ee/billing/warm-pool/claim",
            body=json.dumps(
                {
                    "organisation_id": w.org_alpha_id,
                    "checkout_id": "cs_fabricated_999",
                    "region": "fr-par-s4",
                    "profile_ref": "s4-v1",
                }
            ).encode(),
            headers={**alpha_owner_hdr, "Idempotency-Key": "idem-s4-fab-key"},
            environ=env,
        )
        assert r_fab_claim.status_code == 403

        # Now `org_alpha` claims with its paid Sovereign PO ref -> warm-pool claim #1 succeeds (201),
        # claim #2 with its bound invoice ref hits per-tenant cap (`409`), and `org_bravo` with paid PO
        # reusing the EXACT SAME `Idempotency-Key` (`idem-s4-shared-key`) succeeds (`E02-003`)!
        r_claim1 = router.dispatch(
            "POST",
            "/api/v1/ee/billing/warm-pool/claim",
            body=json.dumps(
                {
                    "organisation_id": w.org_alpha_id,
                    "checkout_id": po_cat_id,
                    "region": "fr-par-s4",
                    "profile_ref": "s4-v1",
                }
            ).encode(),
            headers={**alpha_owner_hdr, "Idempotency-Key": "idem-s4-shared-key"},
            environ=env,
        )
        assert r_claim1.status_code == 201
        claimed_slot_alpha = str(r_claim1.json()["slot"]["slot_id"])

        r_claim2_cap = router.dispatch(
            "POST",
            "/api/v1/ee/billing/warm-pool/claim",
            body=json.dumps(
                {
                    "organisation_id": w.org_alpha_id,
                    "checkout_id": "INV-KODERA-2026-09401",
                    "region": "fr-par-s4",
                    "profile_ref": "s4-v1",
                }
            ).encode(),
            headers={**alpha_owner_hdr, "Idempotency-Key": "idem-s4-second-key"},
            environ=env,
        )
        assert r_claim2_cap.status_code == 409

        # Cross-tenant idempotency isolation: `org_bravo` with paid Sovereign PO reuses `idem-s4-shared-key`!
        r_bravo_po = router.dispatch(
            "POST",
            "/api/v1/ee/billing/purchase-orders",
            body=json.dumps(
                {
                    "organisation_id": w.org_bravo_id,
                    "customer_po_reference": "BDC-BRAVO-S4-01",
                    "plan_code": "sovereign",
                    "billing_months": 12,
                    "committed_seats": 25,
                    "committed_storage_gb": 100,
                }
            ).encode(),
            headers=staff_hdr,
            environ=env,
        )
        bravo_po_id = str(r_bravo_po.json()["po_id"])
        bravo_total = int(r_bravo_po.json()["total_incl_vat_minor"])
        bravo_po_sub = int(r_bravo_po.json()["subtotal_excl_vat_minor"])
        bravo_vat = int(r_bravo_po.json()["vat_amount_minor"])
        inv_bravo_s4 = self._seed_core_invoice(
            organisation_id=w.org_bravo_id,
            number="KODERA-2026-09403",
            subtotal_excl_vat_minor=bravo_po_sub,
            vat_amount_minor=bravo_vat,
        )
        self._settle_core_invoice(inv_bravo_s4, payment_ref="WIRE-BRAVO-9403")
        for b_hdr, b_pay in (
            (staff_hdr, {"action": "issue"}),
            (bravo_owner_hdr, {"action": "countersign", "signatory": "Bravo Owner"}),
            (staff_hdr, {"action": "invoice", "invoice_ref": "INV-KODERA-2026-09403"}),
            (
                staff_hdr,
                {
                    "action": "pay",
                    "invoice_ref": "INV-KODERA-2026-09403",
                    "payment_ref": "WIRE-BRAVO-9403",
                    "amount_paid_minor": bravo_total,
                },
            ),
        ):
            assert (
                router.dispatch(
                    "POST",
                    f"/api/v1/ee/billing/purchase-orders/{bravo_po_id}/transitions",
                    body=json.dumps(b_pay).encode(),
                    headers=b_hdr,
                    environ=env,
                ).status_code
                == 200
            )
        r_bravo_claim = router.dispatch(
            "POST",
            "/api/v1/ee/billing/warm-pool/claim",
            body=json.dumps(
                {
                    "organisation_id": w.org_bravo_id,
                    "checkout_id": bravo_po_id,
                    "region": "fr-par-s4",
                    "profile_ref": "s4-v1",
                }
            ).encode(),
            headers={**bravo_owner_hdr, "Idempotency-Key": "idem-s4-shared-key"},
            environ=env,
        )
        assert r_bravo_claim.status_code == 201
        assert r_bravo_claim.json()["slot"]["slot_id"] != claimed_slot_alpha

        # Customer cannot release warm-pool slot (403); staff operator releases it (200), freeing cap!
        assert (
            router.dispatch(
                "POST",
                "/api/v1/ee/billing/warm-pool/release",
                body=json.dumps({"slot_id": claimed_slot_alpha, "reason": "customer_try"}).encode(),
                headers=alpha_owner_hdr,
                environ=env,
            ).status_code
            == 403
        )
        r_release = router.dispatch(
            "POST",
            "/api/v1/ee/billing/warm-pool/release",
            body=json.dumps(
                {"slot_id": claimed_slot_alpha, "reason": "checkout_cancelled"}
            ).encode(),
            headers=staff_hdr,
            environ=env,
        )
        assert r_release.status_code == 200
        assert r_release.json()["slot"]["state"] == "evicted"

        r_claim_after_release = router.dispatch(
            "POST",
            "/api/v1/ee/billing/warm-pool/claim",
            body=json.dumps(
                {
                    "organisation_id": w.org_alpha_id,
                    "checkout_id": po_cat_id,
                    "region": "fr-par-s4",
                    "profile_ref": "s4-v1",
                }
            ).encode(),
            headers={**alpha_owner_hdr, "Idempotency-Key": "idem-s4-third-key"},
            environ=env,
        )
        assert r_claim_after_release.status_code == 201

        # --- BUG-0059: Zero cross-tenant PO existence or lock-contention oracle ---
        cfg = connection.settings_dict
        with psycopg.connect(
            host=cfg["HOST"],
            port=cfg["PORT"],
            dbname=cfg["NAME"],
            user=cfg["USER"],
            password=cfg["PASSWORD"],
            autocommit=False,
        ) as conn2:
            # Hold exclusive row lock on `org_alpha` AND `po_cat_id` on `conn2`!
            conn2.execute(
                "SELECT 1 FROM orgs_organisation WHERE id = %s FOR UPDATE",
                [w.org_alpha_id],
            )
            conn2.execute(
                "SELECT 1 FROM ee_billing_purchase_orders WHERE po_id = %s FOR UPDATE",
                [po_cat_id],
            )

            # `bravo_owner` probing `po_cat_id` MUST get 404 (NEVER 409 lock contention or 403),
            # identical to probing a non-existent `po_00000000-0000-7000-8000-000000000000`!
            missing_id = "po_00000000-0000-7000-8000-000000000000"
            r_foreign_get = router.dispatch(
                "GET",
                f"/api/v1/ee/billing/purchase-orders/{po_cat_id}",
                headers=bravo_owner_hdr,
                environ=env,
            )
            r_missing_get = router.dispatch(
                "GET",
                f"/api/v1/ee/billing/purchase-orders/{missing_id}",
                headers=bravo_owner_hdr,
                environ=env,
            )
            assert r_foreign_get.status_code == 404
            assert r_missing_get.status_code == 404
            assert r_foreign_get.json() == r_missing_get.json()

            r_foreign_mut = router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{po_cat_id}/transitions",
                body=json.dumps({"action": "countersign", "signatory": "Bravo Probe"}).encode(),
                headers=bravo_owner_hdr,
                environ=env,
            )
            r_missing_mut = router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{missing_id}/transitions",
                body=json.dumps({"action": "countersign", "signatory": "Bravo Probe"}).encode(),
                headers=bravo_owner_hdr,
                environ=env,
            )
            assert r_foreign_mut.status_code == 404
            assert r_missing_mut.status_code == 404
            assert r_foreign_mut.json() == r_missing_mut.json()
            conn2.rollback()


@pytest.mark.django_db
def test_auto_backend_warm_pool_claims_and_sovereign_three_slot_cap() -> None:
    """Verify `_AutoWarmPoolStore.list_slots` (`backend='auto'`) and Sovereign `max_total=3` cap."""
    from django.db import connection

    from ee.billing.api import BillingPrincipal, EnterpriseBillingRouter

    with connection.cursor() as cursor:
        cursor.execute(
            "DELETE FROM ee_billing_warm_pool_slots WHERE profile_ref = %s",
            ["sovereign-pro2-s-v1"],
        )

    staff_principal = BillingPrincipal(
        lane="staff",
        staff_roles=frozenset({"staff_operator"}),
        identity_id="staff:sre-1",
        live_authority=False,
    )
    router = EnterpriseBillingRouter(
        backend="auto",
        authenticator=lambda _hdrs: staff_principal,
    )
    env = {"KODERA_EDITION": "enterprise"}

    # Replenish Sovereign profile through default EE router (`max_total=16` on standard profiles,
    # clamped to `SOVEREIGN_POOL_WATERMARKS`: `target_ready=2, max_total=3`).
    r_rep1 = router.dispatch(
        "POST",
        "/api/v1/ee/billing/warm-pool/replenish",
        body=json.dumps({"region": "fr-par", "profile_ref": "sovereign-pro2-s-v1"}).encode(),
        environ=env,
    )
    assert r_rep1.status_code == 200
    created_1 = r_rep1.json()["created_slots"]
    assert len(created_1) == 2

    # Mark first 2 ready, claim 1 via internal store, replenish again -> at most 3 non-evicted slots total!
    for slot in created_1:
        assert (
            router.dispatch(
                "POST",
                f"/api/v1/ee/billing/warm-pool/slots/{slot['slot_id']}/ready",
                environ=env,
            ).status_code
            == 200
        )

    r_claims_ready = router.dispatch(
        "GET",
        "/api/v1/ee/billing/warm-pool/claims?state=ready&profile_ref=sovereign-pro2-s-v1",
        environ=env,
    )
    assert r_claims_ready.status_code == 200
    assert r_claims_ready.json()["count"] == 2

    # Mark one unhealthy (occupying 1 of 3 active slots) and replenish: only 1 slot can be added (`2 + 1 == 3`).
    router.warm_pool.mark_unhealthy(created_1[0]["slot_id"], reason="health-probe-failed")
    r_rep2 = router.dispatch(
        "POST",
        "/api/v1/ee/billing/warm-pool/replenish",
        body=json.dumps({"region": "fr-par", "profile_ref": "sovereign-pro2-s-v1"}).encode(),
        environ=env,
    )
    assert r_rep2.status_code == 200
    assert r_rep2.json()["count"] == 1

    # Another replenish at ceiling `3` creates `0` slots.
    r_rep3 = router.dispatch(
        "POST",
        "/api/v1/ee/billing/warm-pool/replenish",
        body=json.dumps({"region": "fr-par", "profile_ref": "sovereign-pro2-s-v1"}).encode(),
        environ=env,
    )
    assert r_rep3.status_code == 200
    assert r_rep3.json()["count"] == 0

    r_snap = router.dispatch(
        "GET",
        "/api/v1/ee/billing/warm-pool?profile_ref=sovereign-pro2-s-v1",
        environ=env,
    )
    assert r_snap.status_code == 200
    snap = r_snap.json()
    assert (
        snap["provisioning_count"]
        + snap["ready_count"]
        + snap["claimed_count"]
        + snap["unhealthy_count"]
        == 3
    )


@pytest.mark.django_db(transaction=True)
def test_django_http_warm_pool_summary_forwards_profile_and_region_query_params(
    ee_billing_pg_world,
    monkeypatch,
) -> None:
    """Prove `GET /api/v1/ee/billing/warm-pool?profile_ref=sovereign-pro2-s-v1&region=fr-par`
    forwards query filters through `ee/billing/urls.py` instead of returning the default pool."""
    from django.db import connection
    from django.test import Client

    w = ee_billing_pg_world
    monkeypatch.setenv("KODERA_EDITION", "enterprise")
    client = Client()

    with connection.cursor() as cursor:
        cursor.execute(
            "DELETE FROM ee_billing_warm_pool_slots WHERE profile_ref IN (%s, %s)",
            ["sovereign-pro2-s-v1", "default-other-v1"],
        )

    r_other = client.post(
        "/api/v1/ee/billing/warm-pool/replenish",
        data=json.dumps({"region": "fr-par", "profile_ref": "default-other-v1"}).encode("utf-8"),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {w.staff_token}",
    )
    assert r_other.status_code == 200

    r_sov = client.post(
        "/api/v1/ee/billing/warm-pool/replenish",
        data=json.dumps({"region": "fr-par", "profile_ref": "sovereign-pro2-s-v1"}).encode("utf-8"),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {w.staff_token}",
    )
    assert r_sov.status_code == 200
    created_sov = r_sov.json()["created_slots"]
    assert 1 <= len(created_sov) <= 3

    r_ready = client.post(
        f"/api/v1/ee/billing/warm-pool/slots/{created_sov[0]['slot_id']}/ready",
        data=b"{}",
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {w.staff_token}",
    )
    assert r_ready.status_code == 200

    r_summary = client.get(
        "/api/v1/ee/billing/warm-pool?profile_ref=sovereign-pro2-s-v1&region=fr-par",
        HTTP_AUTHORIZATION=f"Bearer {w.staff_token}",
    )
    assert r_summary.status_code == 200, r_summary.content
    summary = r_summary.json()
    assert summary["profile_ref"] == "sovereign-pro2-s-v1"
    assert summary["region"] == "fr-par"
    assert summary["ready_count"] == 1
    assert summary["provisioning_count"] + summary["ready_count"] <= 3


@pytest.mark.django_db
def test_postgres_backend_warm_pool_replenishes_after_claimed_slots_exceed_max_total() -> None:
    """Verify `PostgresWarmPoolStore` (`backend='postgres'`) counts only `provisioning`, `ready`,
    and `unhealthy` slots against `max_total`, so `claimed` customer slots never freeze pool
    replenishment once `claimed_count >= max_total`."""
    from django.db import connection

    profile_ref = "r8-pg-claimed-v1"
    with connection.cursor() as cursor:
        cursor.execute(
            "DELETE FROM ee_billing_warm_pool_slots WHERE profile_ref = %s",
            [profile_ref],
        )

    pool = WarmPoolController(
        PoolWatermarks(min_ready=1, target_ready=2, max_total=3),
        default_region="fr-par",
        default_profile_ref=profile_ref,
        backend="postgres",
    )

    for batch_idx in (0, 1):
        allocated = pool.replenish()
        assert len(allocated) == 2
        for offset, slot in enumerate(allocated):
            pool.mark_ready(slot.slot_id)
            claim = pool.claim_slot(
                idempotency_key=f"idem-00000000000004{batch_idx}{offset}",
                organisation_id=f"org_pg_claim_{batch_idx}_{offset}",
                checkout_id=f"cs_pg_claim_{batch_idx}_{offset}",
            )
            assert claim.replayed is False

    # 4 slots are now `claimed` (`> max_total == 3`), and 0 slots are `provisioning` or `ready`.
    snap_before = pool.sizing_snapshot()
    assert snap_before.claimed_count == 4
    assert snap_before.ready_count == 0
    assert snap_before.provisioning_count == 0
    assert snap_before.replenish_needed == 2

    replenished = pool.replenish()
    assert len(replenished) == 2
    snap_after = pool.sizing_snapshot()
    assert snap_after.claimed_count == 4
    assert snap_after.provisioning_count == 2
    assert snap_after.replenish_needed == 0
