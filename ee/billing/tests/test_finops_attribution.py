# SPDX-License-Identifier: LicenseRef-Kodera-EE
# ruff: noqa: S101
"""Offline unit, invariant, HTTP RBAC, and CLI tests for per-tenant FinOps attribution."""

from __future__ import annotations

import io
import json
from collections.abc import Mapping
from dataclasses import replace
from decimal import Decimal
from pathlib import Path

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import RequestFactory, override_settings

from ee.billing.api import (
    FINOPS_RECONCILE_PATH,
    MAX_FINOPS_BODY_BYTES,
    BillingForbiddenError,
    BillingPrincipal,
    BillingUnauthenticatedError,
    EnterpriseBillingRouter,
)
from ee.billing.finops import (
    FinOpsValidationError,
    TenantResourceUsage,
    proportional_floor_allocate,
    reconcile_finops_attribution,
    reconcile_finops_payload,
    verify_finops_report,
)
from ee.billing.pricing import MIN_GROSS_MARGIN_BPS
from ee.billing.urls import handle_django_request


def _finops_test_auth(headers: Mapping[str, str]) -> BillingPrincipal:
    auth = headers.get("authorization", "")
    if auth == "Bearer staff-op":
        return BillingPrincipal(
            lane="staff",
            identity_id="staff-1",
            staff_roles=frozenset({"staff_operator"}),
        )
    if auth == "Bearer staff-support":
        return BillingPrincipal(
            lane="staff",
            identity_id="staff-2",
            staff_roles=frozenset({"staff_support"}),
        )
    if auth == "Bearer staff-none":
        return BillingPrincipal(
            lane="staff",
            identity_id="staff-3",
            staff_roles=frozenset({"staff_viewer_unknown"}),
        )
    if auth == "Bearer customer-owner":
        return BillingPrincipal(
            lane="customer",
            identity_id="cust-1",
            org_roles={"org_alpha": "org_owner"},
        )
    if auth == "Bearer disabled":
        raise BillingForbiddenError()
    raise BillingUnauthenticatedError()


def _sample_usage(
    org_id: str,
    *,
    cpu: int = 1_000,
    ram: int = 1_073_741_824,
    s3_store: int = 10_000_000,
    s3_egress: int = 2_000_000,
    turn_bytes: int = 5_000_000,
    seats: int = 10,
    revenue_minor: int = 29_000,
) -> TenantResourceUsage:
    return TenantResourceUsage(
        organisation_id=org_id,
        cpu_millicore_seconds=cpu,
        ram_byte_seconds=ram,
        s3_storage_bytes=s3_store,
        s3_egress_bytes=s3_egress,
        livekit_turn_relay_bytes=turn_bytes,
        active_seats=seats,
        tenant_revenue_excl_vat_minor=revenue_minor,
    )


class TestStrictIntegerAndBoundsValidation:
    @pytest.mark.parametrize("bad_val", [True, False, 12.5, 0.0, Decimal("10"), "10", None])
    @pytest.mark.parametrize(
        "field",
        [
            "cpu_millicore_seconds",
            "ram_byte_seconds",
            "s3_storage_bytes",
            "s3_egress_bytes",
            "livekit_turn_relay_bytes",
            "active_seats",
            "tenant_revenue_excl_vat_minor",
        ],
    )
    def test_tenant_usage_rejects_non_strict_int_fields(self, bad_val: object, field: str) -> None:
        kwargs: dict[str, object] = {
            "organisation_id": "org_strict",
            "cpu_millicore_seconds": 100,
            "ram_byte_seconds": 100,
            "s3_storage_bytes": 100,
            "s3_egress_bytes": 100,
            "livekit_turn_relay_bytes": 100,
            "active_seats": 5,
            "tenant_revenue_excl_vat_minor": 6_000,
        }
        kwargs[field] = bad_val
        with pytest.raises(TypeError):
            TenantResourceUsage(**kwargs)  # type: ignore[arg-type]

    @pytest.mark.parametrize("bad_val", [True, False, 100.0, Decimal("100"), "100", None])
    @pytest.mark.parametrize(
        "pool_field",
        [
            "provider_invoice_total_minor",
            "compute_pool_minor",
            "s3_pool_minor",
            "turn_livekit_pool_minor",
            "shared_platform_minor",
        ],
    )
    def test_reconcile_rejects_non_strict_int_pool_and_invoice_amounts(
        self, bad_val: object, pool_field: str
    ) -> None:
        kwargs: dict[str, object] = {
            "provider_invoice_total_minor": 10_000,
            "compute_pool_minor": 4_000,
            "s3_pool_minor": 2_000,
            "turn_livekit_pool_minor": 1_000,
            "shared_platform_minor": 1_000,
            "tenants": [_sample_usage("org_a")],
        }
        kwargs[pool_field] = bad_val
        with pytest.raises(TypeError):
            reconcile_finops_attribution(**kwargs)  # type: ignore[arg-type]

    def test_negative_metrics_and_invalid_identifiers_fail_closed(self) -> None:
        with pytest.raises(FinOpsValidationError) as exc_neg:
            _sample_usage("org_a", cpu=-1)
        assert exc_neg.value.code == "negative_finops_metric"

        with pytest.raises(FinOpsValidationError) as exc_rev:
            _sample_usage("org_a", revenue_minor=-50)
        assert exc_rev.value.code == "negative_amount"

        for bad_org in ("", "org with space", "org/slash", "x" * 129):
            with pytest.raises(FinOpsValidationError) as exc_id:
                _sample_usage(bad_org)
            assert exc_id.value.code == "invalid_organisation_id"

        with pytest.raises(FinOpsValidationError) as exc_dup:
            reconcile_finops_attribution(
                provider_invoice_total_minor=5_000,
                compute_pool_minor=2_000,
                s3_pool_minor=1_000,
                turn_livekit_pool_minor=1_000,
                shared_platform_minor=1_000,
                tenants=[_sample_usage("org_dup"), _sample_usage("org_dup")],
            )
        assert exc_dup.value.code == "duplicate_organisation_id"


class TestProportionalFloorAllocationAndReconciliation:
    def test_indivisible_pool_floor_division_never_invents_cents_or_exceeds_pool(self) -> None:
        shares, remainder = proportional_floor_allocate(100, [1, 1, 1], pool_name="compute")
        assert shares == (33, 33, 33)
        assert sum(shares) == 99
        assert remainder == 1
        assert sum(shares) + remainder == 100

        zero_usage_shares, zero_rem = proportional_floor_allocate(250, [0, 0], pool_name="turn")
        assert zero_usage_shares == (0, 0)
        assert zero_rem == 250

    def test_full_reconciliation_conserves_invoice_total_and_is_permutation_invariant(
        self,
    ) -> None:
        t1 = _sample_usage(
            "org_alpha",
            cpu=1_000,
            ram=0,
            s3_store=100,
            s3_egress=0,
            turn_bytes=10,
            seats=10,
            revenue_minor=30_000,
        )
        t2 = _sample_usage(
            "org_beta",
            cpu=1_000,
            ram=0,
            s3_store=100,
            s3_egress=0,
            turn_bytes=10,
            seats=10,
            revenue_minor=30_000,
        )
        t3 = _sample_usage(
            "org_gamma",
            cpu=1_000,
            ram=0,
            s3_store=100,
            s3_egress=0,
            turn_bytes=10,
            seats=10,
            revenue_minor=5_000,  # Low revenue -> flagged below 4400 bps floor!
        )

        # Pools: 10,000 + 5,000 + 2,500 + 2,500 = 20,000 cents.
        # Provider invoice includes 3,500 cents of idle warm-pool + control-plane overhead = 23,500.
        report_fwd = reconcile_finops_attribution(
            provider_invoice_total_minor=23_500,
            compute_pool_minor=10_000,
            s3_pool_minor=5_000,
            turn_livekit_pool_minor=2_500,
            shared_platform_minor=2_500,
            tenants=[t3, t1, t2],
            billing_period="2026-M11",
            provider_invoice_ref="SCW-INV-9001",
        )
        report_rev = reconcile_finops_attribution(
            provider_invoice_total_minor=23_500,
            compute_pool_minor=10_000,
            s3_pool_minor=5_000,
            turn_livekit_pool_minor=2_500,
            shared_platform_minor=2_500,
            tenants=[t1, t2, t3],
            billing_period="2026-M11",
            provider_invoice_ref="SCW-INV-9001",
        )
        assert report_fwd == report_rev

        # Each tenant gets:
        # compute: 10,000 // 3 = 3,333 (allocated=9,999, rem=1)
        # s3:       5,000 // 3 = 1,666 (allocated=4,998, rem=2)
        # turn:     2,500 // 3 =   833 (allocated=2,499, rem=1)
        # shared:   2,500 // 3 =   833 (allocated=2,499, rem=1)
        # per-tenant total = 6,665; allocated_total_minor = 19,995; pool_unallocated_minor = 5;
        # unpooled_overhead_minor = 3,500; unallocated_remainder_minor = 3,505.
        assert report_fwd.pools_subtotal_minor == 20_000
        assert report_fwd.allocated_compute_minor == 9_999
        assert report_fwd.allocated_s3_minor == 4_998
        assert report_fwd.allocated_turn_livekit_minor == 2_499
        assert report_fwd.allocated_shared_platform_minor == 2_499
        assert report_fwd.allocated_total_minor == 19_995
        assert report_fwd.pool_unallocated_minor == 5
        assert report_fwd.unpooled_overhead_minor == 3_500
        assert report_fwd.unallocated_remainder_minor == 3_505
        assert (
            report_fwd.allocated_total_minor + report_fwd.unallocated_remainder_minor
            == report_fwd.provider_invoice_total_minor
        )

        # Check gross margins: org_alpha & org_beta have (30000 - 6665)*10000//30000 = 7778 bps (>=4400).
        # org_gamma has (5000 - 6665)*10000//5000 = -3330 bps (< 4400 -> flagged!).
        by_org = {row.organisation_id: row for row in report_fwd.tenants}
        assert by_org["org_alpha"].total_attributed_minor == 6_665
        assert by_org["org_alpha"].gross_margin_bps == 7_778
        assert by_org["org_alpha"].below_margin_floor is False
        assert by_org["org_gamma"].gross_margin_bps == -3_330
        assert by_org["org_gamma"].below_margin_floor is True
        assert report_fwd.flagged_organisation_ids == ("org_gamma",)

    def test_refuses_invoice_below_pool_sum_and_remainder_conservation_violation(self) -> None:
        with pytest.raises(FinOpsValidationError) as exc_below:
            reconcile_finops_attribution(
                provider_invoice_total_minor=9_999,
                compute_pool_minor=4_000,
                s3_pool_minor=3_000,
                turn_livekit_pool_minor=2_000,
                shared_platform_minor=1_000,
                tenants=[_sample_usage("org_a")],
            )
        assert exc_below.value.code == "invoice_below_pool_sum"

        with pytest.raises(FinOpsValidationError) as exc_rem:
            reconcile_finops_attribution(
                provider_invoice_total_minor=12_000,
                compute_pool_minor=4_000,
                s3_pool_minor=3_000,
                turn_livekit_pool_minor=2_000,
                shared_platform_minor=1_000,
                tenants=[_sample_usage("org_a")],
                expected_unallocated_remainder_minor=1_999,  # Actual remainder is 2_000
            )
        assert exc_rem.value.code == "invoice_reconciliation_mismatch"

        valid = reconcile_finops_attribution(
            provider_invoice_total_minor=12_000,
            compute_pool_minor=4_000,
            s3_pool_minor=3_000,
            turn_livekit_pool_minor=2_000,
            shared_platform_minor=1_000,
            tenants=[_sample_usage("org_a")],
            expected_unallocated_remainder_minor=2_000,
        )
        tampered = replace(valid, unallocated_remainder_minor=valid.unallocated_remainder_minor + 1)
        with pytest.raises(FinOpsValidationError) as exc_tamper:
            verify_finops_report(tampered)
        assert exc_tamper.value.code == "invoice_reconciliation_mismatch"

    def test_exact_4400_bps_margin_boundary_and_zero_revenue_flagging(self) -> None:
        # COGS = 5,600 on 10,000 revenue -> exact 4,400 bps (not flagged).
        # COGS = 5,601 on 10,000 revenue -> 4,399 bps (flagged!).
        report = reconcile_finops_attribution(
            provider_invoice_total_minor=11_201,
            compute_pool_minor=11_201,
            s3_pool_minor=0,
            turn_livekit_pool_minor=0,
            shared_platform_minor=0,
            tenants=[
                _sample_usage("org_exact_4400", cpu=5_600, ram=0, revenue_minor=10_000),
                _sample_usage("org_below_4399", cpu=5_601, ram=0, revenue_minor=10_000),
                _sample_usage("org_zero_rev", cpu=0, ram=0, revenue_minor=0),
            ],
        )
        assert report.min_gross_margin_bps == MIN_GROSS_MARGIN_BPS == 4_400
        by_org = {row.organisation_id: row for row in report.tenants}
        assert by_org["org_exact_4400"].gross_margin_bps == 4_400
        assert by_org["org_exact_4400"].below_margin_floor is False
        assert by_org["org_below_4399"].gross_margin_bps == 4_399
        assert by_org["org_below_4399"].below_margin_floor is True
        assert by_org["org_zero_rev"].below_margin_floor is True
        assert report.flagged_organisation_ids == ("org_below_4399", "org_zero_rev")


class TestFinOpsHttpEndpointAndCli:
    def _valid_payload_dict(self) -> dict[str, object]:
        return {
            "currency": "EUR",
            "billing_period": "2026-M11",
            "provider_invoice_ref": "SCW-INV-42",
            "provider_invoice_total_minor": 15_000,
            "compute_pool_minor": 6_000,
            "s3_pool_minor": 3_000,
            "turn_livekit_pool_minor": 2_000,
            "shared_platform_minor": 1_000,
            "tenants": [
                {
                    "organisation_id": "org_1",
                    "cpu_millicore_seconds": 2_000,
                    "ram_byte_seconds": 0,
                    "s3_storage_bytes": 5_000,
                    "s3_egress_bytes": 1_000,
                    "livekit_turn_relay_bytes": 4_000,
                    "active_seats": 20,
                    "tenant_revenue_excl_vat_minor": 25_000,
                },
                {
                    "organisation_id": "org_2",
                    "cpu_millicore_seconds": 1_000,
                    "ram_byte_seconds": 0,
                    "s3_storage_bytes": 2_000,
                    "s3_egress_bytes": 1_000,
                    "livekit_turn_relay_bytes": 4_000,
                    "active_seats": 20,
                    "tenant_revenue_excl_vat_minor": 6_000,
                },
            ],
        }

    def test_router_edition_gate_rbac_and_validation_responses(self) -> None:
        router = EnterpriseBillingRouter(backend="memory", authenticator=_finops_test_auth)
        body = json.dumps(self._valid_payload_dict()).encode("utf-8")

        # 1. Community mode returns 404.
        res_comm = router.dispatch(
            "POST",
            FINOPS_RECONCILE_PATH,
            body=body,
            headers={"Authorization": "Bearer staff-op"},
            environ={"KODERA_EDITION": "community"},
        )
        assert res_comm.status_code == 404

        ee_env = {"KODERA_EDITION": "enterprise"}

        # 2. Unauthenticated -> 401; Customer or unauthorized staff -> 403; GET -> 405.
        res_401 = router.dispatch("POST", FINOPS_RECONCILE_PATH, body=body, environ=ee_env)
        assert res_401.status_code == 401
        assert res_401.headers.get("WWW-Authenticate") == "Bearer"

        for forbidden_token in ("Bearer customer-owner", "Bearer staff-none", "Bearer disabled"):
            res_403 = router.dispatch(
                "POST",
                FINOPS_RECONCILE_PATH,
                body=body,
                headers={"Authorization": forbidden_token},
                environ=ee_env,
            )
            assert res_403.status_code == 403

        res_405 = router.dispatch(
            "GET",
            FINOPS_RECONCILE_PATH,
            headers={"Authorization": "Bearer staff-op"},
            environ=ee_env,
        )
        assert res_405.status_code == 405

        # 3. Staff operator & staff support succeed with 200 and full conservation.
        for ok_token in ("Bearer staff-op", "Bearer staff-support"):
            res_ok = router.dispatch(
                "POST",
                FINOPS_RECONCILE_PATH,
                body=body,
                headers={"Authorization": ok_token},
                environ=ee_env,
            )
            assert res_ok.status_code == 200
            doc = res_ok.json()
            assert (
                doc["allocated_total_minor"] + doc["unallocated_remainder_minor"]
                == doc["provider_invoice_total_minor"]
                == 15_000
            )
            assert doc["flagged_organisation_ids"] == ["org_2"]

        # 4. Float JSON value -> 422; invoice < sum(pools) -> 422; duplicate keys / oversized -> 400.
        bad_float_payload = self._valid_payload_dict()
        bad_float_payload["compute_pool_minor"] = 6000.0
        res_float = router.dispatch(
            "POST",
            FINOPS_RECONCILE_PATH,
            body=json.dumps(bad_float_payload).encode("utf-8"),
            headers={"Authorization": "Bearer staff-op"},
            environ=ee_env,
        )
        assert res_float.status_code == 422

        bad_inv_payload = self._valid_payload_dict()
        bad_inv_payload["provider_invoice_total_minor"] = 5_000
        res_inv = router.dispatch(
            "POST",
            FINOPS_RECONCILE_PATH,
            body=json.dumps(bad_inv_payload).encode("utf-8"),
            headers={"Authorization": "Bearer staff-op"},
            environ=ee_env,
        )
        assert res_inv.status_code == 422
        assert "less than the sum" in res_inv.json()["detail"]

        res_dup_key = router.dispatch(
            "POST",
            FINOPS_RECONCILE_PATH,
            body=b'{"currency":"EUR","currency":"USD"}',
            headers={"Authorization": "Bearer staff-op"},
            environ=ee_env,
        )
        assert res_dup_key.status_code == 400

        res_oversized = router.dispatch(
            "POST",
            FINOPS_RECONCILE_PATH,
            body=b"x" * (MAX_FINOPS_BODY_BYTES + 1),
            headers={"Authorization": "Bearer staff-op"},
            environ=ee_env,
        )
        assert res_oversized.status_code == 400

    def test_django_urls_adapter_with_internal_operator_token(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        internal_token = "internal-finops-operator-token-0123456789abcdef"
        monkeypatch.setenv("KODERA_EDITION", "enterprise")
        monkeypatch.setenv("KODERA_EE_INTERNAL_TOKEN", internal_token)
        rf = RequestFactory()
        req = rf.post(
            FINOPS_RECONCILE_PATH,
            data=json.dumps(self._valid_payload_dict()).encode("utf-8"),
            content_type="application/json",
            HTTP_X_KODERA_INTERNAL_TOKEN=internal_token,
        )
        resp = handle_django_request(req)
        assert resp.status_code == 200
        parsed = json.loads(resp.content.decode("utf-8"))
        assert parsed["allocated_total_minor"] + parsed["unallocated_remainder_minor"] == 15_000

    def test_management_command_reconcile_finops_attribution(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        input_path = tmp_path / "finops-batch.json"
        payload = self._valid_payload_dict()
        input_path.write_text(json.dumps(payload), encoding="utf-8")

        # 1. Refused in Community edition.
        monkeypatch.setenv("KODERA_EDITION", "community")
        with (
            override_settings(KODERA_EDITION="community"),
            pytest.raises(CommandError, match="KODERA_EDITION=enterprise"),
        ):
            call_command("reconcile_finops_attribution", input=input_path)

        # 2. Refuses leaf and ancestor symlinked input paths even in Enterprise mode.
        symlink_path = tmp_path / "finops-link.json"
        symlink_path.symlink_to(input_path)
        real_subdir = tmp_path / "real-dir"
        real_subdir.mkdir()
        nested_input = real_subdir / "batch.json"
        nested_input.write_text(json.dumps(payload), encoding="utf-8")
        symlink_dir = tmp_path / "linked-dir"
        symlink_dir.symlink_to(real_subdir)
        monkeypatch.setenv("KODERA_EDITION", "enterprise")
        for candidate in (symlink_path, symlink_dir / "batch.json"):
            with (
                override_settings(KODERA_EDITION="enterprise"),
                pytest.raises(CommandError, match="symbolic links"),
            ):
                call_command("reconcile_finops_attribution", input=candidate)

        # 3. Succeeds in Enterprise mode and flags low-margin tenant when --fail-below-margin-floor set.
        out = io.StringIO()
        with override_settings(KODERA_EDITION="enterprise"):
            call_command("reconcile_finops_attribution", input=input_path, stdout=out)
        emitted = json.loads(out.getvalue())
        assert emitted["provider_invoice_total_minor"] == 15_000
        assert emitted["flagged_organisation_ids"] == ["org_2"]

        out_flagged = io.StringIO()
        with (
            override_settings(KODERA_EDITION="enterprise"),
            pytest.raises(CommandError, match="gross-margin floor review required"),
        ):
            call_command(
                "reconcile_finops_attribution",
                input=input_path,
                fail_below_margin_floor=True,
                stdout=out_flagged,
            )
        assert json.loads(out_flagged.getvalue())["flagged_organisation_ids"] == ["org_2"]

        # 4. Payload parser rejects non-array tenants cleanly.
        with pytest.raises(FinOpsValidationError) as exc_bad_tenants:
            reconcile_finops_payload({**payload, "tenants": "not-a-list"})
        assert exc_bad_tenants.value.code == "invalid_tenants_payload"
