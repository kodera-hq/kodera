"""Workspace-scoped AI policy and consent persistence helpers."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from django.utils import timezone

from .models import (
    AI_PROVIDER_REGIONS as AI_PROVIDER_REGIONS,
    AI_PROVIDERS as AI_PROVIDERS,
    DEFAULT_MONTHLY_AI_BUDGET_MICROS as DEFAULT_MONTHLY_AI_BUDGET_MICROS,
    Channel,
    MemberAiConsent,
    WorkspaceAiPolicy,
)


def current_budget_period() -> str:
    return timezone.now().strftime("%Y-%m")


@dataclass(frozen=True)
class WorkspaceAiPolicySnapshot:
    id: UUID
    organisation_id: UUID
    workspace_id: UUID
    enabled: bool
    provider: str
    provider_region: str
    eu_sovereign_only: bool
    self_hosted_endpoint: str
    model: str
    sealed_byom_config: bytes
    monthly_budget_micros: int
    monthly_spent_micros: int
    budget_period: str


@dataclass(frozen=True)
class ChannelAiSnapshot:
    id: UUID
    workspace_id: UUID
    lifecycle: str
    is_confidential: bool
    ai_enabled: bool


@dataclass(frozen=True)
class MemberAiConsentSnapshot:
    id: UUID
    enabled: bool
    consented_at: datetime | None
    revoked_at: datetime | None


def _policy_snapshot(policy: WorkspaceAiPolicy) -> WorkspaceAiPolicySnapshot:
    period = current_budget_period()
    effective_spent = int(policy.monthly_spent_micros) if policy.budget_period == period else 0
    return WorkspaceAiPolicySnapshot(
        id=policy.id,
        organisation_id=policy.organisation_id,
        workspace_id=policy.workspace_id,
        enabled=bool(policy.enabled),
        provider=policy.provider,
        provider_region=policy.provider_region,
        eu_sovereign_only=bool(policy.eu_sovereign_only),
        self_hosted_endpoint=policy.self_hosted_endpoint,
        model=policy.model,
        sealed_byom_config=bytes(policy.sealed_byom_config),
        monthly_budget_micros=int(policy.monthly_budget_micros),
        monthly_spent_micros=effective_spent,
        budget_period=period,
    )


def _consent_snapshot(consent: MemberAiConsent) -> MemberAiConsentSnapshot:
    return MemberAiConsentSnapshot(
        id=consent.id,
        enabled=bool(consent.enabled),
        consented_at=consent.consented_at,
        revoked_at=consent.revoked_at,
    )


def get_workspace_ai_policy_snapshot(
    *,
    organisation_id: UUID,
    workspace_id: UUID,
    for_update: bool = False,
) -> WorkspaceAiPolicySnapshot | None:
    queryset = (
        WorkspaceAiPolicy.objects.select_for_update() if for_update else WorkspaceAiPolicy.objects
    )
    row = queryset.filter(
        organisation_id=organisation_id,
        workspace_id=workspace_id,
    ).first()
    return _policy_snapshot(row) if row is not None else None


def get_channel_ai_snapshot(
    *,
    channel_id: UUID,
    workspace_id: UUID,
    for_update: bool = False,
) -> ChannelAiSnapshot | None:
    queryset = Channel.objects.select_for_update() if for_update else Channel.objects
    row = queryset.filter(id=channel_id, workspace_id=workspace_id).first()
    if row is None:
        return None
    return ChannelAiSnapshot(
        id=row.id,
        workspace_id=row.workspace_id,
        lifecycle=row.lifecycle,
        is_confidential=bool(row.is_confidential),
        ai_enabled=bool(row.ai_enabled),
    )


def get_member_ai_consent_snapshot(
    *,
    organisation_id: UUID,
    workspace_id: UUID,
    membership_id: UUID,
    identity_id: UUID,
    for_update: bool = False,
) -> MemberAiConsentSnapshot | None:
    queryset = (
        MemberAiConsent.objects.select_for_update() if for_update else MemberAiConsent.objects
    )
    row = queryset.filter(
        organisation_id=organisation_id,
        workspace_id=workspace_id,
        membership_id=membership_id,
        identity_id=identity_id,
    ).first()
    return _consent_snapshot(row) if row is not None else None


def get_active_member_ai_consents_for_memberships(
    *,
    organisation_id: UUID,
    workspace_id: UUID,
    membership_ids: Sequence[UUID],
    for_update: bool = False,
) -> dict[UUID, MemberAiConsentSnapshot]:
    """Return active non-revoked MemberAiConsent snapshots keyed by membership_id."""
    if not membership_ids:
        return {}
    queryset = (
        MemberAiConsent.objects.select_for_update() if for_update else MemberAiConsent.objects
    )
    rows = queryset.filter(
        organisation_id=organisation_id,
        workspace_id=workspace_id,
        membership_id__in=list(membership_ids),
        enabled=True,
        revoked_at__isnull=True,
        consented_at__isnull=False,
    ).order_by("id")
    return {row.membership_id: _consent_snapshot(row) for row in rows}


def upsert_workspace_ai_policy(
    *,
    organisation_id: UUID,
    workspace_id: UUID,
    enabled: bool,
    provider: str,
    provider_region: str,
    eu_sovereign_only: bool,
    self_hosted_endpoint: str,
    model: str,
    sealed_byom_config: bytes,
    monthly_budget_micros: int = DEFAULT_MONTHLY_AI_BUDGET_MICROS,
) -> WorkspaceAiPolicySnapshot:
    period = current_budget_period()
    existing = (
        WorkspaceAiPolicy.objects.select_for_update()
        .filter(
            organisation_id=organisation_id,
            workspace_id=workspace_id,
        )
        .first()
    )
    if existing is None:
        created = WorkspaceAiPolicy.objects.create(
            organisation_id=organisation_id,
            workspace_id=workspace_id,
            enabled=enabled,
            provider=provider,
            provider_region=provider_region,
            eu_sovereign_only=eu_sovereign_only,
            self_hosted_endpoint=self_hosted_endpoint,
            model=model,
            sealed_byom_config=sealed_byom_config,
            monthly_budget_micros=monthly_budget_micros,
            monthly_spent_micros=0,
            budget_period=period,
        )
        return _policy_snapshot(created)
    effective_spent = int(existing.monthly_spent_micros) if existing.budget_period == period else 0
    WorkspaceAiPolicy.objects.filter(pk=existing.pk).update(
        enabled=enabled,
        provider=provider,
        provider_region=provider_region,
        eu_sovereign_only=eu_sovereign_only,
        self_hosted_endpoint=self_hosted_endpoint,
        model=model,
        sealed_byom_config=sealed_byom_config,
        monthly_budget_micros=monthly_budget_micros,
        monthly_spent_micros=effective_spent,
        budget_period=period,
        updated_at=timezone.now(),
    )
    existing.refresh_from_db()
    return _policy_snapshot(existing)


def reserve_workspace_ai_budget(
    *,
    organisation_id: UUID,
    workspace_id: UUID,
    reserve_micros: int,
) -> bool:
    if reserve_micros < 0:
        return False
    row = (
        WorkspaceAiPolicy.objects.select_for_update()
        .filter(organisation_id=organisation_id, workspace_id=workspace_id)
        .first()
    )
    if row is None:
        return False
    period = current_budget_period()
    spent = int(row.monthly_spent_micros) if row.budget_period == period else 0
    if spent + reserve_micros > int(row.monthly_budget_micros):
        return False
    WorkspaceAiPolicy.objects.filter(pk=row.pk).update(
        monthly_spent_micros=spent + reserve_micros,
        budget_period=period,
        updated_at=timezone.now(),
    )
    return True


def reconcile_workspace_ai_budget(
    *,
    organisation_id: UUID,
    workspace_id: UUID,
    reserved_micros: int,
    actual_micros: int,
) -> None:
    row = (
        WorkspaceAiPolicy.objects.select_for_update()
        .filter(organisation_id=organisation_id, workspace_id=workspace_id)
        .first()
    )
    if row is None:
        return
    period = current_budget_period()
    spent = int(row.monthly_spent_micros) if row.budget_period == period else 0
    updated_spent = max(0, spent - max(0, reserved_micros) + max(0, actual_micros))
    WorkspaceAiPolicy.objects.filter(pk=row.pk).update(
        monthly_spent_micros=updated_spent,
        budget_period=period,
        updated_at=timezone.now(),
    )


def refund_workspace_ai_budget(
    *,
    organisation_id: UUID,
    workspace_id: UUID,
    reserved_micros: int,
) -> None:
    reconcile_workspace_ai_budget(
        organisation_id=organisation_id,
        workspace_id=workspace_id,
        reserved_micros=reserved_micros,
        actual_micros=0,
    )


def set_channel_ai_enabled(*, channel_id: UUID, ai_enabled: bool) -> None:
    Channel.objects.filter(pk=channel_id).update(
        ai_enabled=ai_enabled,
        updated_at=timezone.now(),
    )


def upsert_member_ai_consent(
    *,
    organisation_id: UUID,
    workspace_id: UUID,
    membership_id: UUID,
    identity_id: UUID,
    enabled: bool,
) -> MemberAiConsentSnapshot:
    now = timezone.now()
    existing = (
        MemberAiConsent.objects.select_for_update()
        .filter(
            organisation_id=organisation_id,
            workspace_id=workspace_id,
            membership_id=membership_id,
            identity_id=identity_id,
        )
        .first()
    )
    if existing is None:
        created = MemberAiConsent.objects.create(
            organisation_id=organisation_id,
            workspace_id=workspace_id,
            membership_id=membership_id,
            identity_id=identity_id,
            enabled=enabled,
            consented_at=now if enabled else None,
            revoked_at=None if enabled else now,
        )
        return _consent_snapshot(created)
    consented_at = now if enabled else existing.consented_at
    revoked_at = None if enabled else now
    MemberAiConsent.objects.filter(pk=existing.pk).update(
        enabled=enabled,
        consented_at=consented_at,
        revoked_at=revoked_at,
        updated_at=now,
    )
    existing.refresh_from_db()
    return _consent_snapshot(existing)
