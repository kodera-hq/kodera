"""Automated Sovereign order settlement, Factur-X 380 publication, and WarmPool claim.

Strictly ADR-0003 compliant: zero cloud provider credentials in Core API and zero static `ee`
imports in the open-source tree (`ee.billing` is loaded dynamically only when Enterprise edition
is enabled).
"""

from __future__ import annotations

import hashlib
import importlib
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from django.db import connection

from apps.audit.services import record_system_tenant_event
from apps.jobs._enqueue import enqueue_job
from apps.jobs.types import JobRequest
from apps.orgs.selectors import organisation_plan_tier_state, set_organisation_plan_tier
from apps.tenancy.services import (
    LockedSettlementTenant,
    lock_tenant_for_settlement,
    transition_tenant_status,
)
from apps.workspaces.services import sync_subscription_quota
from core.api.edition import ENTERPRISE_EDITION, _ensure_ee_importable, active_edition

from .artifacts import publish
from .documents import Renderer, Validator, render_cii, snapshot_of
from .models import BillingArtifact, CapacityTier, Invoice, Order, Subscription
from .services import issue_invoice

SOVEREIGN_PROFILE_REF = "sovereign-pro2-s-v1"
OFFLINE_VALIDATOR_REF = "verapdf-1.30.2/factur-x-7.9/saxonche-13.1.1/en16931"

PLAN_TIER_CLOUD_COLLABORATIVE = "cloud_collaborative"
PLAN_TIER_SOVEREIGN = "sovereign"
PLAN_TIER_ENTERPRISE = "enterprise"

TIER_TO_VM_SHAPE: dict[str, str] = {
    "S": "PRO2-S",
    "M": "PRO2-M",
    "L": "PRO2-L",
    "XL": "PRO2-L",
}

SOVEREIGN_TIER_SEATS: dict[str, int] = {
    "S": 25,
    "M": 100,
    "L": 250,
}


@dataclass(frozen=True, slots=True)
class SettlementOutcome:
    artifact_id: UUID | None
    snapshot_sha256: str
    cii_xml_sha256: str
    plan_tier: str | None
    warm_pool_mode: str | None
    warm_pool_slot_id: str | None
    job_id: UUID | None


def resolve_subscription_seat_quota(subscription: Subscription) -> int:
    """Derive seat quota from Core's persisted subscription, honouring Sovereign 25/100/250 tiers."""
    if subscription.plan_code == "sovereign" or subscription.pack_code == "sovereign":
        sovereign_seats = SOVEREIGN_TIER_SEATS.get(subscription.capacity_tier_code)
        if sovereign_seats is not None:
            return sovereign_seats * int(subscription.quantity)
    tier_seats = (
        CapacityTier.objects.filter(code=subscription.capacity_tier_code)
        .values_list("seats_included", flat=True)
        .first()
    )
    if tier_seats is not None and tier_seats >= 1:
        return int(tier_seats) * int(subscription.quantity)
    return int(subscription.quantity)


_resolve_seat_quota = resolve_subscription_seat_quota


def _target_plan_tier(subscription: Subscription, *, shared_realm: bool) -> str:
    if subscription.plan_code == "enterprise":
        return PLAN_TIER_ENTERPRISE
    if subscription.plan_code == "sovereign" or subscription.pack_code == "sovereign":
        return PLAN_TIER_SOVEREIGN
    if shared_realm:
        return PLAN_TIER_CLOUD_COLLABORATIVE
    return PLAN_TIER_SOVEREIGN


def _is_sovereign_order(order: Order, tenant: LockedSettlementTenant) -> bool:
    return (
        order.plan_code == "sovereign"
        or order.pack_code == "sovereign"
        or tenant.profile_ref == SOVEREIGN_PROFILE_REF
    )


def _load_ee_warm_pool() -> tuple[Any, Any, Any, Any, Any] | None:
    if active_edition() != ENTERPRISE_EDITION:
        return None
    _ensure_ee_importable()
    try:
        wp_mod = importlib.import_module("ee.billing.warm_pool")
        st_mod = importlib.import_module("ee.billing.storage")
    except ImportError:
        return None
    return (
        wp_mod.WarmPoolController,
        wp_mod.SOVEREIGN_POOL_WATERMARKS,
        wp_mod.WarmPoolExhaustedError,
        wp_mod.WarmPoolTenantCapExceededError,
        st_mod.CallerAuthority,
    )


def resolve_subscription_storage_quota_bytes(subscription: Subscription) -> int:
    """Derive storage ceiling in bytes from Core's persisted subscription tier."""
    tier_storage = (
        CapacityTier.objects.filter(code=subscription.capacity_tier_code)
        .values_list("storage_included_bytes", flat=True)
        .first()
    )
    if tier_storage is not None and tier_storage >= 1:
        return int(tier_storage) * int(subscription.quantity)
    return 10 * 1024 * 1024 * 1024


def sync_organisation_plan_tier_for_subscription(subscription: Subscription) -> str | None:
    """Promote `Organisation.plan_tier` and sync `WorkspaceQuota` when a subscription is active."""
    org_row = organisation_plan_tier_state(organisation_id=subscription.organisation_id)
    if org_row is None:
        return None
    shared_realm, current_tier, is_community = org_row
    if is_community:
        return current_tier
    target_tier = _target_plan_tier(subscription, shared_realm=shared_realm)
    if current_tier != target_tier:
        set_organisation_plan_tier(
            organisation_id=subscription.organisation_id,
            plan_tier=target_tier,
        )
    from apps.billing.boosts import recompute_workspace_boost_quota
    from apps.workspaces.selectors import workspace_id_for

    ws_id = workspace_id_for(organisation_id=subscription.organisation_id)
    if ws_id is not None:
        recompute_workspace_boost_quota(
            organisation_id=subscription.organisation_id,
            workspace_id=ws_id,
        )
    else:
        sync_subscription_quota(
            organisation_id=subscription.organisation_id,
            policy_ref=f"subscription:{subscription.plan_code}:active",
            seats=_resolve_seat_quota(subscription),
            media_bytes=resolve_subscription_storage_quota_bytes(subscription),
            update_storage=True,
        )
    return target_tier


def settle_paid_order_and_invoice(
    *,
    invoice: Invoice,
    order: Order | None,
    renderer: Renderer | None = None,
    validator: Validator | None = None,
    validator_ref: str = OFFLINE_VALIDATOR_REF,
) -> SettlementOutcome:
    """Freeze statutory CII 380 snapshot, sync plan_tier/quota, and trigger Sovereign WarmPool/job.

    Optional PDF/A-3b + Factur-X conformance rendering belongs strictly to the offline operator
    pipeline (`manage.py render_billing_document`); HTTP webhook settlement never requires
    `sRGB2014.icc` or unvalidated PDF synthesis in the stripped API container.
    """
    if not connection.in_atomic_block:
        raise RuntimeError("settle_paid_order_and_invoice requires an atomic transaction")

    if invoice.state == "draft":
        issue_invoice(invoice)

    snapshot = snapshot_of(invoice)
    cii_xml = render_cii(snapshot)
    cii_xml_sha256 = hashlib.sha256(cii_xml).hexdigest()

    artifact: BillingArtifact | None = None
    if (
        order is not None
        and invoice.pdf_ref is None
        and renderer is not None
        and validator is not None
    ):
        artifact = publish(
            document_id=invoice.id,
            credit_note=False,
            renderer=renderer,
            validator=validator,
            validator_ref=validator_ref,
        )
        invoice.pdf_ref = f"urn:kodera:billing-artifact:{artifact.id}"

    plan_tier: str | None = None
    if invoice.subscription_id is not None:
        sub = Subscription.objects.filter(id=invoice.subscription_id).first()
        if sub is not None and sub.state == "active":
            plan_tier = sync_organisation_plan_tier_for_subscription(sub)

    if order is None or order.tenant_id is None:
        return SettlementOutcome(
            artifact_id=None if artifact is None else artifact.id,
            snapshot_sha256=snapshot.sha256,
            cii_xml_sha256=cii_xml_sha256,
            plan_tier=plan_tier,
            warm_pool_mode=None,
            warm_pool_slot_id=None,
            job_id=None,
        )

    tenant = lock_tenant_for_settlement(tenant_id=order.tenant_id)
    if tenant is None or not _is_sovereign_order(order, tenant) or tenant.status != "ordered":
        return SettlementOutcome(
            artifact_id=None if artifact is None else artifact.id,
            snapshot_sha256=snapshot.sha256,
            cii_xml_sha256=cii_xml_sha256,
            plan_tier=plan_tier,
            warm_pool_mode=None,
            warm_pool_slot_id=None,
            job_id=None,
        )

    vm_shape = CapacityTier.objects.filter(code=order.capacity_tier_code).values_list(
        "vm_shape", flat=True
    ).first() or TIER_TO_VM_SHAPE.get(order.capacity_tier_code, "PRO2-S")
    ee_wp = _load_ee_warm_pool()
    controller: Any = None
    internal_authority: Any = None
    fallback_errors: tuple[type[BaseException], ...] = ()
    if ee_wp is not None:
        controller_cls, watermarks, exhausted_cls, cap_exceeded_cls, authority_cls = ee_wp
        fallback_errors = (exhausted_cls, cap_exceeded_cls)
        controller = controller_cls(
            watermarks,
            default_region=tenant.region,
            default_profile_ref=SOVEREIGN_PROFILE_REF,
            backend="postgres",
        )
        internal_authority = authority_cls(
            lane="internal",
            identity_id="system:stripe-webhook",
            live_authority=True,
        )

    # Fast Path: pre-warmed PRO2-S cell available in `ee_billing_warm_pool_slots`
    if vm_shape == "PRO2-S" and controller is not None:
        try:
            claimed = controller.claim_slot(
                idempotency_key=f"order:{order.id}",
                organisation_id=str(order.organisation_id),
                checkout_id=str(order.id),
                region=tenant.region,
                profile_ref=SOVEREIGN_PROFILE_REF,
                authority=internal_authority,
            )
            transition_tenant_status(
                tenant_id=tenant.id,
                expected_status="ordered",
                next_status="provisioning",
            )
            record_system_tenant_event(
                action="tenant.provision_requested",
                tenant_id=tenant.id,
                organisation_id=order.organisation_id,
                metadata={
                    "from": "ordered",
                    "to": "provisioning",
                    "order_id": str(order.id),
                    "vm_shape": vm_shape,
                    "warm_pool_slot_id": claimed.slot.slot_id,
                },
            )
            realm_idem = hashlib.sha256(
                f"sovereign-realm-key:{order.id}".encode("ascii")
            ).hexdigest()
            realm_hash = hashlib.sha256(
                f"sovereign-realm:{order.organisation_id}:{tenant.id}".encode("ascii")
            ).hexdigest()
            enqueued = enqueue_job(
                request=JobRequest(
                    kind="realm_create",
                    organisation_id=order.organisation_id,
                    tenant_id=None,
                    idempotency_key=realm_idem,
                    desired_spec_hash=realm_hash,
                    actor_type="system",
                    actor_id=None,
                    request_id=None,
                ),
                apply_desired_state=lambda: None,
            )
            controller.replenish(
                region=tenant.region,
                profile_ref=SOVEREIGN_PROFILE_REF,
                authority=internal_authority,
            )
            return SettlementOutcome(
                artifact_id=None if artifact is None else artifact.id,
                snapshot_sha256=snapshot.sha256,
                cii_xml_sha256=cii_xml_sha256,
                plan_tier=plan_tier,
                warm_pool_mode="fast_path",
                warm_pool_slot_id=claimed.slot.slot_id,
                job_id=enqueued.job_id,
            )
        except Exception as exc:
            if not fallback_errors or not isinstance(exc, fallback_errors):
                raise

    # Cold Fallback Path: WarmPoolExhaustedError or PRO2-M / PRO2-L tier
    prov_idem = hashlib.sha256(f"sovereign-provision-key:{order.id}".encode("ascii")).hexdigest()
    prov_hash = hashlib.sha256(
        f"sovereign-provision:{order.id}:{tenant.id}:{vm_shape}".encode("ascii")
    ).hexdigest()

    def _mark_provisioning() -> None:
        moved = transition_tenant_status(
            tenant_id=tenant.id,
            expected_status="ordered",
            next_status="provisioning",
        )
        if moved:
            record_system_tenant_event(
                action="tenant.provision_requested",
                tenant_id=tenant.id,
                organisation_id=order.organisation_id,
                metadata={
                    "from": "ordered",
                    "to": "provisioning",
                    "order_id": str(order.id),
                    "vm_shape": vm_shape,
                    "warm_pool": "cold_fallback",
                },
            )

    enqueued = enqueue_job(
        request=JobRequest(
            kind="provision",
            organisation_id=order.organisation_id,
            tenant_id=tenant.id,
            idempotency_key=prov_idem,
            desired_spec_hash=prov_hash,
            actor_type="system",
            actor_id=None,
            request_id=None,
        ),
        apply_desired_state=_mark_provisioning,
    )
    if controller is not None and vm_shape == "PRO2-S":
        controller.replenish(
            region=tenant.region,
            profile_ref=SOVEREIGN_PROFILE_REF,
            authority=internal_authority,
        )
    return SettlementOutcome(
        artifact_id=None if artifact is None else artifact.id,
        snapshot_sha256=snapshot.sha256,
        cii_xml_sha256=cii_xml_sha256,
        plan_tier=plan_tier,
        warm_pool_mode="cold_fallback",
        warm_pool_slot_id=None,
        job_id=enqueued.job_id,
    )
