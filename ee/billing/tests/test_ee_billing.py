# SPDX-License-Identifier: LicenseRef-Kodera-EE
# ruff: noqa: S101
"""Unit and HTTP contract tests for Enterprise commercial billing (`ee/billing/`)."""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from ee.billing import (
    EnterpriseEditionRequiredError,
    is_enterprise_edition,
    require_enterprise_edition,
)
from ee.billing.api import EnterpriseBillingRouter
from ee.billing.pricing import (
    MIN_GROSS_MARGIN_BPS,
    SOVEREIGN_BASE_ANNUAL_CENTS,
    SOVEREIGN_BASE_MONTHLY_CENTS,
    SOVEREIGN_INCLUDED_SEATS,
    TEAM_ANNUAL_SEAT_MONTHLY_CENTS,
    TEAM_ANNUAL_SEAT_YEARLY_CENTS,
    TEAM_MONTHLY_SEAT_CENTS,
    MarginFloorViolationError,
    PricingValidationError,
    commercial_schedule_summary,
    compute_gross_margin_bps,
    compute_vat_minor,
    enforce_margin_floor,
    list_price_excl_vat_minor,
    quote_plan,
    require_strict_int,
)
from ee.billing.purchase_orders import (
    CommitmentExceededError,
    InvalidPurchaseOrderTransitionError,
    PurchaseOrderBook,
    PurchaseOrderNotFoundError,
    PurchaseOrderValidationError,
    validate_invoice_reference,
)
from ee.billing.warm_pool import (
    PoolWatermarks,
    WarmPoolController,
    WarmPoolExhaustedError,
    WarmPoolIdempotencyConflictError,
    WarmPoolTransitionError,
    WarmPoolValidationError,
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
        assert annual.list_excl_vat_minor == 60_000  # 10 * 5 EUR * 12 = 600.00 EUR
        assert annual.net_excl_vat_minor == 60_000
        assert annual.vat_amount_minor == 12_000
        assert annual.total_incl_vat_minor == 72_000
        assert annual.gross_margin_bps >= MIN_GROSS_MARGIN_BPS

        monthly = quote_plan("team", seats=10, billing_cycle="monthly", vat_rate_bps=2_000)
        assert monthly.list_excl_vat_minor == 6_000  # 10 * 6 EUR = 60.00 EUR
        assert monthly.vat_amount_minor == 1_200
        assert monthly.total_incl_vat_minor == 7_200
        assert monthly.gross_margin_bps >= MIN_GROSS_MARGIN_BPS

    def test_sovereign_base_and_tiered_seat_overages(self) -> None:
        base_quote = quote_plan("sovereign", seats=25, billing_cycle="monthly")
        assert base_quote.list_excl_vat_minor == 29_000
        assert base_quote.gross_margin_bps == 5_000  # (29000 - 14500) / 29000 = 50.0%

        # 30 seats monthly -> 25 included + 5 seats in 26..100 bracket @ 800c = 29000 + 4000 = 33000c
        tier1 = quote_plan("sovereign", seats=30, billing_cycle="monthly")
        assert tier1.list_excl_vat_minor == 33_000

        # 120 seats monthly -> 25 incl + 75 @ 800c (60_000) + 20 @ 600c (12_000) + 29_000 = 101_000c
        tier2 = list_price_excl_vat_minor("sovereign", seats=120, billing_cycle="monthly")
        assert tier2 == 101_000

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
        # 43.99% -> 4399 bps -> refused
        with pytest.raises(MarginFloorViolationError) as exc_info:
            enforce_margin_floor(10_000, 5_601)
        assert exc_info.value.actual_bps == 4_399
        assert exc_info.value.required_bps == 4_400

        # Exact 44.00% -> 4400 bps -> accepted
        assert enforce_margin_floor(10_000, 5_600) == 4_400
        assert compute_gross_margin_bps(10_000, 5_600) == 4_400

        # Excessive discount pushing Team below 44% margin -> refused
        with pytest.raises(MarginFloorViolationError):
            quote_plan("team", seats=20, billing_cycle="monthly", discount_bps=7_000)

    def test_community_plan_and_schedule_summary(self) -> None:
        community = quote_plan("community", seats=5, vat_rate_bps=2_000)
        assert community.total_incl_vat_minor == 0
        with pytest.raises(PricingValidationError):
            quote_plan("community", seats=5, custom_net_excl_vat_minor=100)

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
        pool = WarmPoolController(PoolWatermarks(min_ready=2, target_ready=3, max_total=4))
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

        # Quarantine oldest slot -> claim must skip it and pick sequence 2!
        pool.mark_unhealthy(created[0].slot_id, reason="livekit-probe-timeout")
        claim1 = pool.claim_slot(
            idempotency_key="idem-checkout-0001",
            organisation_id="org_alpha",
            checkout_id="cs_live_0001",
        )
        assert claim1.replayed is False
        assert claim1.slot.slot_id == created[1].slot_id
        assert claim1.below_low_watermark is True  # only 1 ready left < min_ready=2

        # Exact idempotent replay returns identical slot without consuming created[2]
        replay = pool.claim_slot(
            idempotency_key="idem-checkout-0001",
            organisation_id="org_alpha",
            checkout_id="cs_live_0001",
        )
        assert replay.replayed is True
        assert replay.slot.slot_id == created[1].slot_id
        assert pool.sizing_snapshot().ready_count == 1

        # Reusing same idempotency_key for another org/checkout fails with conflict
        with pytest.raises(WarmPoolIdempotencyConflictError):
            pool.claim_slot(
                idempotency_key="idem-checkout-0001",
                organisation_id="org_beta",
                checkout_id="cs_live_9999",
            )

        # Evict unhealthy slot frees ceiling capacity so replenish can fill 2 slots back to target=3
        evicted = pool.evict_unhealthy()
        assert [s.slot_id for s in evicted] == [created[0].slot_id]
        replenished = pool.replenish()
        assert len(replenished) == 2

        # Illegal state transitions fail deterministically
        with pytest.raises(WarmPoolTransitionError):
            pool.mark_unhealthy(claim1.slot.slot_id, reason="cannot-unhealthy-claimed")

    def test_exhausted_pool_and_concurrent_claims_never_double_allocate(self) -> None:
        pool = WarmPoolController(PoolWatermarks(min_ready=1, target_ready=8, max_total=8))
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
        book = PurchaseOrderBook()
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

        # Cannot evaluate commitment or bind invoice before countersignature
        with pytest.raises(InvalidPurchaseOrderTransitionError):
            book.evaluate_commitment(po.po_id, active_seats=10, used_storage_gb=10, environ=env)
        with pytest.raises(InvalidPurchaseOrderTransitionError):
            book.bind_invoice(po.po_id, invoice_ref="INV-KODERA-2026-00001", environ=env)

        po = book.issue(po.po_id, at=t0 + timedelta(hours=1), environ=env)
        assert po.state == "issued"

        po = book.countersign(
            po.po_id,
            signatory="Direction des Achats",
            at=t0 + timedelta(hours=2),
            environ=env,
        )
        assert po.state == "countersigned"

        # Commitment check passes within bounds and fails when exceeded under hard cap
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

        # Invalid invoice reference rejected
        with pytest.raises(PurchaseOrderValidationError):
            validate_invoice_reference("bad-ref-123")
        with pytest.raises(PurchaseOrderValidationError):
            book.bind_invoice(po.po_id, invoice_ref="FAC-2026-01", environ=env)

        po = book.bind_invoice(
            po.po_id,
            invoice_ref="INV-KODERA-2026-00042",
            at=t0 + timedelta(days=1),
            environ=env,
        )
        assert po.state == "invoiced"

        # Wrong payment amount or wrong invoice ref rejected
        with pytest.raises(PurchaseOrderValidationError):
            book.mark_paid(
                po.po_id,
                invoice_ref="INV-KODERA-2026-00042",
                payment_ref="SEPA-WIRE-001",
                amount_paid_minor=900_000,
                environ=env,
            )

        po = book.mark_paid(
            po.po_id,
            invoice_ref="INV-KODERA-2026-00042",
            payment_ref="SEPA-WIRE-001",
            amount_paid_minor=1_080_000,
            at=t0 + timedelta(days=5),
            environ=env,
        )
        assert po.state == "paid"

        # Paid is terminal: cannot expire or re-issue
        with pytest.raises(InvalidPurchaseOrderTransitionError):
            book.expire(po.po_id, environ=env)

    def test_duplicate_invoice_ref_and_expiry_and_edition_guard(self) -> None:
        env = {"KODERA_EDITION": "enterprise"}
        book = PurchaseOrderBook()
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
        book.issue(po1.po_id, at=t0 + timedelta(hours=1), environ=env)
        book.countersign(po1.po_id, signatory="CFO", at=t0 + timedelta(hours=2), environ=env)
        book.bind_invoice(po1.po_id, invoice_ref="INV-KODERA-2026-00100", environ=env)

        book.issue(po2.po_id, at=t0 + timedelta(hours=1), environ=env)
        book.countersign(po2.po_id, signatory="CFO", at=t0 + timedelta(hours=2), environ=env)
        with pytest.raises(PurchaseOrderValidationError):
            book.bind_invoice(po2.po_id, invoice_ref="INV-KODERA-2026-00100", environ=env)

        # Past-expiry draft auto-expires and refuses issuance
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
            ("POST", "/api/v1/ee/billing/warm-pool/claim"),
            ("POST", "/api/v1/ee/billing/purchase-orders"),
            ("GET", "/api/v1/ee/billing/purchase-orders/po_2026_00001"),
            ("POST", "/api/v1/ee/billing/purchase-orders/po_2026_00001/transitions"),
            ("POST", "/api/v1/ee/billing/purchase-orders/po_2026_00001/commitment-check"),
        ],
    )
    def test_community_mode_returns_404_on_every_route(self, method: str, path: str) -> None:
        router = EnterpriseBillingRouter()
        for env in ({}, {"KODERA_EDITION": "community"}, {"KODERA_EDITION": "self-host"}):
            resp = router.dispatch(method, path, environ=env)
            assert resp.status_code == 404
            assert resp.content_type == "application/problem+json"
            assert resp.json()["status"] == 404

    def test_enterprise_mode_serves_plans_quotes_warm_pool_and_pos(self) -> None:
        env = {"KODERA_EDITION": "enterprise"}
        router = EnterpriseBillingRouter()

        plans_resp = router.dispatch("GET", "/api/v1/ee/billing/plans", environ=env)
        assert plans_resp.status_code == 200
        assert plans_resp.json()["min_gross_margin_bps"] == 4_400

        quote_resp = router.dispatch(
            "POST",
            "/api/v1/ee/billing/quotes",
            body=json.dumps({"plan_code": "team", "seats": 12, "billing_cycle": "annual"}).encode(),
            environ=env,
        )
        assert quote_resp.status_code == 200
        assert quote_resp.json()["net_excl_vat_minor"] == 72_000

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
            environ=env,
        )
        assert bad_margin_resp.status_code == 422

        # Warm pool replenish -> mark_ready -> claim -> idempotent replay
        rep_resp = router.dispatch("POST", "/api/v1/ee/billing/warm-pool/replenish", environ=env)
        assert rep_resp.status_code == 200
        first_slot_id = rep_resp.json()["created_slots"][0]["slot_id"]
        router.warm_pool.mark_ready(first_slot_id)

        claim_body = json.dumps(
            {"organisation_id": "org_acme", "checkout_id": "cs_test_123"}
        ).encode()
        claim_resp = router.dispatch(
            "POST",
            "/api/v1/ee/billing/warm-pool/claim",
            body=claim_body,
            headers={"Idempotency-Key": "idem-http-claim-01"},
            environ=env,
        )
        assert claim_resp.status_code == 201
        assert claim_resp.json()["replayed"] is False

        replay_resp = router.dispatch(
            "POST",
            "/api/v1/ee/billing/warm-pool/claim",
            body=claim_body,
            headers={"Idempotency-Key": "idem-http-claim-01"},
            environ=env,
        )
        assert replay_resp.status_code == 200
        assert replay_resp.json()["replayed"] is True

        # Purchase Order flow over HTTP
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
            environ=env,
        )
        assert po_create.status_code == 201
        po_id = po_create.json()["po_id"]

        for payload in (
            {"action": "issue"},
            {"action": "countersign", "signatory": "VP Finance"},
            {"action": "invoice", "invoice_ref": "INV-KODERA-2026-00777"},
            {
                "action": "pay",
                "invoice_ref": "INV-KODERA-2026-00777",
                "payment_ref": "WIRE-777",
                "amount_paid_minor": 720_000,
            },
        ):
            step = router.dispatch(
                "POST",
                f"/api/v1/ee/billing/purchase-orders/{po_id}/transitions",
                body=json.dumps(payload).encode(),
                environ=env,
            )
            assert step.status_code == 200

        paid_po = router.dispatch("GET", f"/api/v1/ee/billing/purchase-orders/{po_id}", environ=env)
        assert paid_po.status_code == 200
        assert paid_po.json()["state"] == "paid"

        commit_ok = router.dispatch(
            "POST",
            f"/api/v1/ee/billing/purchase-orders/{po_id}/commitment-check",
            body=json.dumps({"active_seats": 40, "used_storage_gb": 200}).encode(),
            environ=env,
        )
        assert commit_ok.status_code == 200
        assert commit_ok.json()["within_commitment"] is True

        commit_over = router.dispatch(
            "POST",
            f"/api/v1/ee/billing/purchase-orders/{po_id}/commitment-check",
            body=json.dumps({"active_seats": 99, "used_storage_gb": 200}).encode(),
            environ=env,
        )
        assert commit_over.status_code == 409
