"""Deterministic 0–100 workspace cybersecurity posture scoring and atomic 1-click remediations."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID

from django.conf import settings
from django.db import transaction
from django.db.models import F
from django.utils import timezone

from apps.ai_gateway.adapters import NON_EU_KNOWN_HOSTS
from apps.ai_gateway.sealing import unseal_byom_config
from apps.audit.services import record_workspace_resource_event
from apps.e2ee.selectors import workspace_confidential_posture
from apps.engine_intents.channel_sets import MAX_CHANNELS
from apps.extensions.posture import (
    rotate_stale_workspace_extension_keys,
    workspace_extension_secret_posture,
)
from apps.orgs.actor_selectors import TenantCaller
from apps.orgs.selectors import (
    ensure_security_and_privacy_contacts,
    lock_organisation_fence,
    organisation_security_contacts,
)
from core.sealing import SealError
from services.identity.access_tokens import VerifiedAccessToken

from .ai_policy import (
    WorkspaceAiPolicySnapshot,
    get_workspace_ai_policy_snapshot,
    upsert_workspace_ai_policy,
)
from .iam import authorize, check_manage, emit_iam_channel_set
from .models import (
    DEFAULT_MONTHLY_AI_BUDGET_MICROS,
    POLICY_CAPABILITIES,
    Category,
    Channel,
    Workspace,
    WorkspaceInviteLink,
    WorkspaceRole,
)
from .moderation import RefusalError
from .selectors import lock_workspace

MAX_SAFE_INVITE_HORIZON_DAYS = 7
MAX_SAFE_MONTHLY_AI_BUDGET_MICROS = 500_000_000
DEFAULT_EU_AI_MODEL = "mistral-small-latest"

ADMIN_DESIGNATED_ROLE_SLUGS = frozenset(
    {
        "admin",
        "admins",
        "administrateur",
        "administrateurs",
        "owner",
        "owners",
        "security-admin",
        "security_admin",
    }
)
EXCESS_GOVERNANCE_PERMISSIONS = frozenset(
    {
        "manage_roles",
        "view_audit_log",
        "message.delete_any",
        "file.delete_any",
        "media.moderate",
        "*",
        "admin",
        "workspace.admin",
    }
)
SAFE_MEMBER_CAPABILITIES = frozenset(POLICY_CAPABILITIES) - EXCESS_GOVERNANCE_PERMISSIONS

CHECK_INVITE_HYGIENE = "invite_hygiene"
CHECK_SOVEREIGN_AI = "sovereign_ai_boundary"
CHECK_ALERT_ROUTING = "security_alert_routing"
CHECK_EXTENSION_ROTATION = "extension_secret_rotation"
CHECK_LEAST_PRIVILEGE = "least_privilege_roles"
CHECK_CONFIDENTIAL_READINESS = "confidential_room_readiness"

ACTION_CAP_INVITES = "cap_unbounded_invites"
ACTION_ENFORCE_EU_AI = "enforce_eu_sovereign_ai"
ACTION_PROVISION_ALERTS = "provision_security_alerts_channel"
ACTION_ROTATE_EXTENSIONS = "rotate_stale_extension_keys"
ACTION_STRIP_ROLE_PERMS = "strip_excess_role_permissions"
ACTION_PROVISION_CONFIDENTIAL = "provision_confidential_channel"
ACTION_FIX_ALL_SAFE = "fix_all_safe"

ORDERED_ACTIONS = (
    ACTION_CAP_INVITES,
    ACTION_ENFORCE_EU_AI,
    ACTION_PROVISION_ALERTS,
    ACTION_ROTATE_EXTENSIONS,
    ACTION_STRIP_ROLE_PERMS,
    ACTION_PROVISION_CONFIDENTIAL,
)
VALID_REMEDIATION_ACTIONS = frozenset({*ORDERED_ACTIONS, ACTION_FIX_ALL_SAFE})


@dataclass(frozen=True, slots=True)
class SecurityPostureFacts:
    organisation_id: UUID
    workspace_id: UUID
    unbounded_invite_count: int
    ai_enabled: bool
    ai_eu_sovereign_only: bool
    ai_provider_region: str
    ai_monthly_budget_micros: int
    security_contact_configured: bool
    privacy_contact_configured: bool
    security_alerts_channel_configured: bool
    stale_installation_secret_count: int
    overprivileged_role_count: int
    confidential_channel_count: int
    empty_stale_rekey_room_count: int
    active_stale_rekey_room_count: int = 0
    stale_bridge_secret_count: int = 0
    fixable_overprivileged_role_count: int | None = None
    ai_endpoint_eu_compatible: bool = True


@dataclass(frozen=True, slots=True)
class PostureCheckResult:
    id: str
    status: str  # "pass" | "warn"
    earned_points: int
    max_points: int
    remediation_action: str
    fix_available: bool
    affected_count: int

    def to_wire(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status,
            "earned_points": self.earned_points,
            "max_points": self.max_points,
            "remediation_action": self.remediation_action,
            "fix_available": self.fix_available,
            "affected_count": self.affected_count,
        }


@dataclass(frozen=True, slots=True)
class SecurityPostureReport:
    organisation_id: UUID
    workspace_id: UUID
    score: int
    max_score: int
    grade: str
    passing_checks: int
    total_checks: int
    fixable_checks: int
    checks: tuple[PostureCheckResult, ...]

    def to_wire(self) -> dict[str, Any]:
        return {
            "organisation_id": str(self.organisation_id),
            "workspace_id": str(self.workspace_id),
            "score": self.score,
            "max_score": self.max_score,
            "grade": self.grade,
            "passing_checks": self.passing_checks,
            "total_checks": self.total_checks,
            "fixable_checks": self.fixable_checks,
            "checks": [check.to_wire() for check in self.checks],
        }


def grade_for_score(score: int) -> str:
    if score >= 90:
        return "A"
    if score >= 80:
        return "B"
    if score >= 65:
        return "C"
    if score >= 50:
        return "D"
    if score >= 35:
        return "E"
    return "F"


def role_has_excess_governance_permissions(
    *, slug: str, kind: str, permissions: list[str] | tuple[str, ...]
) -> bool:
    if kind == "role" and slug.strip().lower() in ADMIN_DESIGNATED_ROLE_SLUGS:
        return False
    return any(permission in EXCESS_GOVERNANCE_PERMISSIONS for permission in permissions)


def _https_endpoint_not_known_non_eu(raw_url: str) -> bool:
    cleaned = raw_url.strip()
    if not cleaned:
        return False
    parsed = urlsplit(cleaned)
    host = (parsed.hostname or "").strip().lower()
    if parsed.scheme != "https" or not host:
        return False
    return host not in NON_EU_KNOWN_HOSTS


def ai_endpoint_is_eu_sovereign_compatible(
    snapshot: WorkspaceAiPolicySnapshot | None,
    *,
    organisation_id: UUID,
    workspace_id: UUID,
) -> bool:
    """Verify provider, endpoint URL, and any sealed BYOM config genuinely satisfy EU sovereignty."""
    if snapshot is None:
        return True
    if snapshot.provider_region != "eu":
        return False
    master_key = getattr(settings, "KODERA_AI_SEAL_KEY", None)

    if snapshot.provider == "mistral":
        if snapshot.self_hosted_endpoint.strip():
            return False
        if snapshot.sealed_byom_config:
            if not isinstance(master_key, bytes):
                return False
            try:
                cfg = unseal_byom_config(
                    master_key,
                    organisation_id=organisation_id,
                    workspace_id=workspace_id,
                    sealed_value=snapshot.sealed_byom_config,
                )
            except SealError:
                return False
            return cfg.region == "eu" and _https_endpoint_not_known_non_eu(cfg.endpoint)
        return True

    if snapshot.provider == "self_hosted":
        return _https_endpoint_not_known_non_eu(snapshot.self_hosted_endpoint)

    if snapshot.provider == "byom":
        if not snapshot.sealed_byom_config or not isinstance(master_key, bytes):
            return False
        try:
            cfg = unseal_byom_config(
                master_key,
                organisation_id=organisation_id,
                workspace_id=workspace_id,
                sealed_value=snapshot.sealed_byom_config,
            )
        except SealError:
            return False
        return cfg.region == "eu" and _https_endpoint_not_known_non_eu(cfg.endpoint)

    return False


def evaluate_security_posture(facts: SecurityPostureFacts) -> SecurityPostureReport:
    """Pure, deterministic 0–100 cybersecurity posture evaluator across the 6 weighted checks."""
    # 1. invite_hygiene (20 pts)
    invite_ok = facts.unbounded_invite_count == 0
    c1 = PostureCheckResult(
        id=CHECK_INVITE_HYGIENE,
        status="pass" if invite_ok else "warn",
        earned_points=20 if invite_ok else 0,
        max_points=20,
        remediation_action=ACTION_CAP_INVITES,
        fix_available=not invite_ok,
        affected_count=max(0, facts.unbounded_invite_count),
    )

    # 2. sovereign_ai_boundary (20 pts)
    ai_ok = (not facts.ai_enabled) or (
        facts.ai_eu_sovereign_only
        and facts.ai_provider_region == "eu"
        and facts.ai_endpoint_eu_compatible
        and 0 < facts.ai_monthly_budget_micros <= MAX_SAFE_MONTHLY_AI_BUDGET_MICROS
    )
    c2 = PostureCheckResult(
        id=CHECK_SOVEREIGN_AI,
        status="pass" if ai_ok else "warn",
        earned_points=20 if ai_ok else 0,
        max_points=20,
        remediation_action=ACTION_ENFORCE_EU_AI,
        fix_available=not ai_ok,
        affected_count=0 if ai_ok else 1,
    )

    # 3. security_alert_routing (15 pts)
    missing_routing = (
        int(not facts.security_contact_configured)
        + int(not facts.privacy_contact_configured)
        + int(not facts.security_alerts_channel_configured)
    )
    routing_ok = missing_routing == 0
    c3 = PostureCheckResult(
        id=CHECK_ALERT_ROUTING,
        status="pass" if routing_ok else "warn",
        earned_points=15 if routing_ok else 0,
        max_points=15,
        remediation_action=ACTION_PROVISION_ALERTS,
        fix_available=not routing_ok,
        affected_count=missing_routing,
    )

    # 4. extension_secret_rotation (15 pts)
    stale_inst = max(0, facts.stale_installation_secret_count)
    stale_bridges = max(0, facts.stale_bridge_secret_count)
    total_stale_ext = stale_inst + stale_bridges
    ext_ok = total_stale_ext == 0
    # Automatic 1-click rotation is safe only for dual-key grace-window `Installation` rows;
    # `CoexistenceBridge` secrets require coordinated peer webhook updates.
    c4 = PostureCheckResult(
        id=CHECK_EXTENSION_ROTATION,
        status="pass" if ext_ok else "warn",
        earned_points=15 if ext_ok else 0,
        max_points=15,
        remediation_action=ACTION_ROTATE_EXTENSIONS,
        fix_available=(not ext_ok) and (stale_inst > 0),
        affected_count=total_stale_ext,
    )

    # 5. least_privilege_roles (15 pts)
    overpriv = max(0, facts.overprivileged_role_count)
    fixable_roles = (
        overpriv
        if facts.fixable_overprivileged_role_count is None
        else max(0, facts.fixable_overprivileged_role_count)
    )
    roles_ok = overpriv == 0
    c5 = PostureCheckResult(
        id=CHECK_LEAST_PRIVILEGE,
        status="pass" if roles_ok else "warn",
        earned_points=15 if roles_ok else 0,
        max_points=15,
        remediation_action=ACTION_STRIP_ROLE_PERMS,
        fix_available=(not roles_ok) and (fixable_roles > 0),
        affected_count=overpriv,
    )

    # 6. confidential_room_readiness (15 pts)
    empty_rekey = max(0, facts.empty_stale_rekey_room_count)
    active_rekey = max(0, facts.active_stale_rekey_room_count)
    total_rekey = empty_rekey + active_rekey
    conf_missing = int(facts.confidential_channel_count < 1) + total_rekey
    conf_ok = facts.confidential_channel_count >= 1 and total_rekey == 0
    # Server 1-click remediation ONLY provisions a confidential channel when none exists
    # (`confidential_channel_count == 0`); any `rekey_required=True` room (empty or populated)
    # requires a client-signed MLS commit `Envelope` because the server holds zero MLS keys.
    conf_fixable = facts.confidential_channel_count < 1
    c6 = PostureCheckResult(
        id=CHECK_CONFIDENTIAL_READINESS,
        status="pass" if conf_ok else "warn",
        earned_points=15 if conf_ok else 0,
        max_points=15,
        remediation_action=ACTION_PROVISION_CONFIDENTIAL,
        fix_available=(not conf_ok) and conf_fixable,
        affected_count=conf_missing,
    )

    checks = (c1, c2, c3, c4, c5, c6)
    max_score = sum(c.max_points for c in checks)
    score = sum(c.earned_points for c in checks)
    passing = sum(1 for c in checks if c.status == "pass")
    fixable = sum(1 for c in checks if c.fix_available)
    return SecurityPostureReport(
        organisation_id=facts.organisation_id,
        workspace_id=facts.workspace_id,
        score=score,
        max_score=max_score,
        grade=grade_for_score(score),
        passing_checks=passing,
        total_checks=len(checks),
        fixable_checks=fixable,
        checks=checks,
    )


def _caller_role_ceiling(workspace: Workspace, caller: TenantCaller) -> int | None:
    """Return highest assigned WorkspaceRole position for non-owner callers (`None` if none assigned)."""
    return (
        WorkspaceRole.objects.filter(
            workspace=workspace, workspacememberrole__membership_id=caller.membership_id
        )
        .order_by("-position")
        .values_list("position", flat=True)
        .first()
    )


def _collect_facts(
    workspace: Workspace,
    *,
    caller: TenantCaller | None = None,
    now: datetime | None = None,
) -> SecurityPostureFacts:
    current = now or timezone.now()
    horizon = current + timedelta(days=MAX_SAFE_INVITE_HORIZON_DAYS)
    unbounded_invites = WorkspaceInviteLink.objects.filter(
        workspace=workspace,
        revoked_at__isnull=True,
        expires_at__gt=horizon,
        uses_count__lt=F("max_uses"),
    ).count()

    ai_snapshot = get_workspace_ai_policy_snapshot(
        organisation_id=workspace.organisation_id,
        workspace_id=workspace.id,
        for_update=False,
    )
    if ai_snapshot is None:
        ai_enabled = False
        ai_eu_only = True
        ai_region = "eu"
        ai_budget = DEFAULT_MONTHLY_AI_BUDGET_MICROS
        ai_endpoint_ok = True
    else:
        ai_enabled = ai_snapshot.enabled
        ai_eu_only = ai_snapshot.eu_sovereign_only
        ai_region = ai_snapshot.provider_region
        ai_budget = ai_snapshot.monthly_budget_micros
        ai_endpoint_ok = ai_endpoint_is_eu_sovereign_compatible(
            ai_snapshot,
            organisation_id=workspace.organisation_id,
            workspace_id=workspace.id,
        )

    sec_contact, priv_contact = organisation_security_contacts(
        organisation_id=workspace.organisation_id
    )
    alert_channel_ok = bool(
        workspace.security_alerts_channel_id is not None
        and Channel.objects.filter(
            id=workspace.security_alerts_channel_id,
            workspace=workspace,
            kind=Channel.Kind.TEXT,
            lifecycle__in=[Channel.Lifecycle.ACTIVE, Channel.Lifecycle.PROVISIONING],
        ).exists()
    )

    ext_snapshot = workspace_extension_secret_posture(workspace_id=workspace.id, now=current)

    is_owner = caller is None or caller.role == "org_owner"
    ceiling = None if is_owner or caller is None else _caller_role_ceiling(workspace, caller)
    overprivileged_roles = 0
    fixable_roles = 0
    for slug, kind, permissions, position in WorkspaceRole.objects.filter(
        workspace=workspace
    ).values_list("slug", "kind", "permissions", "position"):
        perm_list = permissions if isinstance(permissions, list) else []
        if role_has_excess_governance_permissions(slug=slug, kind=kind, permissions=perm_list):
            overprivileged_roles += 1
            if is_owner or (ceiling is not None and int(position) < int(ceiling)):
                fixable_roles += 1

    confidential_channels = Channel.objects.filter(
        workspace=workspace,
        is_confidential=True,
        lifecycle__in=[Channel.Lifecycle.ACTIVE, Channel.Lifecycle.PROVISIONING],
    ).count()
    e2ee_snapshot = workspace_confidential_posture(
        organisation_id=workspace.organisation_id,
        workspace_id=workspace.id,
    )

    return SecurityPostureFacts(
        organisation_id=workspace.organisation_id,
        workspace_id=workspace.id,
        unbounded_invite_count=unbounded_invites,
        ai_enabled=ai_enabled,
        ai_eu_sovereign_only=ai_eu_only,
        ai_provider_region=ai_region,
        ai_monthly_budget_micros=ai_budget,
        security_contact_configured=bool(sec_contact),
        privacy_contact_configured=bool(priv_contact),
        security_alerts_channel_configured=alert_channel_ok,
        stale_installation_secret_count=len(ext_snapshot.stale_installation_ids),
        stale_bridge_secret_count=len(ext_snapshot.stale_bridge_ids),
        overprivileged_role_count=overprivileged_roles,
        fixable_overprivileged_role_count=fixable_roles,
        confidential_channel_count=confidential_channels,
        empty_stale_rekey_room_count=len(e2ee_snapshot.empty_rekey_room_ids),
        active_stale_rekey_room_count=len(e2ee_snapshot.active_rekey_room_ids),
        ai_endpoint_eu_compatible=ai_endpoint_ok,
    )


def authorize_posture_admin(
    verified: VerifiedAccessToken, organisation_id: UUID
) -> tuple[Workspace, TenantCaller]:
    return authorize(verified, organisation_id, admin=True)


def read_security_posture(
    *, verified: VerifiedAccessToken, organisation_id: UUID
) -> dict[str, Any]:
    with transaction.atomic():
        workspace, caller = authorize_posture_admin(verified, organisation_id)
        report = evaluate_security_posture(_collect_facts(workspace, caller=caller))
        return report.to_wire()


def _next_channel_position(workspace: Workspace, category: Category | None) -> int:
    qs = Channel.objects.filter(workspace=workspace).exclude(lifecycle=Channel.Lifecycle.DELETED)
    qs = qs.filter(category__isnull=True) if category is None else qs.filter(category=category)
    positions = list(qs.values_list("position", flat=True))
    return (max(positions) + 1) if positions else 0


def _provision_text_channel_if_absent(
    *,
    workspace: Workspace,
    template_key: str,
    default_name: str,
    is_confidential: bool,
    reason: str,
) -> Channel:
    existing = (
        Channel.objects.filter(
            workspace=workspace,
            kind=Channel.Kind.TEXT,
            lifecycle__in=[Channel.Lifecycle.ACTIVE, Channel.Lifecycle.PROVISIONING],
        )
        .filter(
            **({"is_confidential": True} if is_confidential else {"template_key": template_key})
        )
        .order_by("position", "id")
        .first()
    )
    if existing is not None:
        return existing

    by_name = (
        Channel.objects.filter(
            workspace=workspace,
            kind=Channel.Kind.TEXT,
            name=default_name,
            is_confidential=is_confidential,
            lifecycle__in=[Channel.Lifecycle.ACTIVE, Channel.Lifecycle.PROVISIONING],
        )
        .order_by("position", "id")
        .first()
    )
    if by_name is not None:
        return by_name

    total_channels = (
        Channel.objects.filter(workspace=workspace)
        .exclude(lifecycle=Channel.Lifecycle.DELETED)
        .count()
    )
    if total_channels >= MAX_CHANNELS:
        raise RefusalError(409)

    category = Category.objects.filter(workspace=workspace).order_by("position", "id").first()
    position = _next_channel_position(workspace, category)
    used_key = (
        None
        if Channel.objects.filter(workspace=workspace, template_key=template_key).exists()
        else template_key
    )
    channel = Channel.objects.create(
        workspace=workspace,
        category=category,
        kind=Channel.Kind.TEXT,
        name=default_name,
        template_key=used_key,
        topic="",
        position=position,
        policy_mode=Channel.PolicyMode.INHERIT,
        lifecycle=Channel.Lifecycle.ACTIVE,
        is_confidential=is_confidential,
        ai_enabled=False,
    )
    Workspace.objects.filter(pk=workspace.pk).update(
        structure_revision=F("structure_revision") + 1,
        updated_at=timezone.now(),
    )
    workspace.refresh_from_db(fields=["structure_revision", "default_policy_id", "updated_at"])
    emit_iam_channel_set(workspace, reason)
    return channel


def _apply_single_remediation(
    *,
    action: str,
    workspace: Workspace,
    caller: TenantCaller,
    verified: VerifiedAccessToken,
    now: datetime,
    strict_single: bool = False,
) -> bool:
    if action == ACTION_CAP_INVITES:
        horizon = now + timedelta(days=MAX_SAFE_INVITE_HORIZON_DAYS)
        updated = WorkspaceInviteLink.objects.filter(
            workspace=workspace,
            revoked_at__isnull=True,
            expires_at__gt=horizon,
            uses_count__lt=F("max_uses"),
        ).update(expires_at=horizon, updated_at=now)
        return updated > 0

    if action == ACTION_ENFORCE_EU_AI:
        current = get_workspace_ai_policy_snapshot(
            organisation_id=workspace.organisation_id,
            workspace_id=workspace.id,
            for_update=True,
        )
        if current is None:
            return False
        endpoint_ok = ai_endpoint_is_eu_sovereign_compatible(
            current,
            organisation_id=workspace.organisation_id,
            workspace_id=workspace.id,
        )
        bounded_budget = (
            current.monthly_budget_micros
            if 0 < current.monthly_budget_micros <= MAX_SAFE_MONTHLY_AI_BUDGET_MICROS
            else DEFAULT_MONTHLY_AI_BUDGET_MICROS
        )
        if (
            not current.enabled
            and current.eu_sovereign_only
            and current.provider_region == "eu"
            and endpoint_ok
        ):
            return False
        if (
            current.enabled
            and current.eu_sovereign_only
            and endpoint_ok
            and current.monthly_budget_micros == bounded_budget
        ):
            return False

        if endpoint_ok:
            # Provider/endpoint/BYOM is already verified EU-compatible; enforce EU flag + budget cap.
            upsert_workspace_ai_policy(
                organisation_id=workspace.organisation_id,
                workspace_id=workspace.id,
                enabled=current.enabled,
                provider=current.provider,
                provider_region="eu",
                eu_sovereign_only=True,
                self_hosted_endpoint=(
                    current.self_hosted_endpoint if current.provider == "self_hosted" else ""
                ),
                model=current.model,
                sealed_byom_config=current.sealed_byom_config,
                monthly_budget_micros=bounded_budget,
            )
        else:
            # Never relabel a non-EU endpoint or BYOM secret as EU: pause AI and reset to the
            # sovereign EU adapter with custom non-EU endpoints/BYOM cleared until reconfigured.
            upsert_workspace_ai_policy(
                organisation_id=workspace.organisation_id,
                workspace_id=workspace.id,
                enabled=False,
                provider="mistral",
                provider_region="eu",
                eu_sovereign_only=True,
                self_hosted_endpoint="",
                model=DEFAULT_EU_AI_MODEL,
                sealed_byom_config=b"",
                monthly_budget_micros=bounded_budget,
            )
        return True

    if action == ACTION_PROVISION_ALERTS:
        contacts_changed = ensure_security_and_privacy_contacts(
            organisation_id=workspace.organisation_id,
            fallback_email=verified.email if verified.email_verified else None,
        )
        channel_valid = bool(
            workspace.security_alerts_channel_id is not None
            and Channel.objects.filter(
                id=workspace.security_alerts_channel_id,
                workspace=workspace,
                kind=Channel.Kind.TEXT,
                lifecycle__in=[Channel.Lifecycle.ACTIVE, Channel.Lifecycle.PROVISIONING],
            ).exists()
        )
        channel_changed = False
        if not channel_valid:
            alert_channel = _provision_text_channel_if_absent(
                workspace=workspace,
                template_key="security_alerts",
                default_name="security-alerts",
                is_confidential=False,
                reason="workspace.security_posture.alert_channel",
            )
            workspace.security_alerts_channel_id = alert_channel.id
            workspace.save(update_fields=["security_alerts_channel_id", "updated_at"])
            channel_changed = True
        return contacts_changed or channel_changed

    if action == ACTION_ROTATE_EXTENSIONS:
        rotated = rotate_stale_workspace_extension_keys(
            organisation_id=workspace.organisation_id,
            workspace_id=workspace.id,
            actor_identity_id=caller.identity_id,
            now=now,
        )
        return rotated > 0

    if action == ACTION_STRIP_ROLE_PERMS:
        flagged_roles: list[WorkspaceRole] = []
        for role in (
            WorkspaceRole.objects.select_for_update().filter(workspace=workspace).order_by("id")
        ):
            perms = role.permissions if isinstance(role.permissions, list) else []
            if role_has_excess_governance_permissions(
                slug=role.slug, kind=role.kind, permissions=perms
            ):
                flagged_roles.append(role)
        if not flagged_roles:
            return False

        if caller.role == "org_owner":
            manageable = flagged_roles
        else:
            ceiling = _caller_role_ceiling(workspace, caller)
            manageable = [
                r for r in flagged_roles if ceiling is not None and int(r.position) < int(ceiling)
            ]
            if strict_single and len(manageable) < len(flagged_roles):
                check_manage(workspace, caller, flagged_roles)
            if not manageable:
                return False
            check_manage(workspace, caller, manageable)

        for role in manageable:
            perms = role.permissions if isinstance(role.permissions, list) else []
            role.permissions = [p for p in perms if p in SAFE_MEMBER_CAPABILITIES]
            role.save(update_fields=["permissions", "updated_at"])
        emit_iam_channel_set(workspace, "workspace.security_posture.least_privilege")
        return True

    if action == ACTION_PROVISION_CONFIDENTIAL:
        has_conf = Channel.objects.filter(
            workspace=workspace,
            is_confidential=True,
            lifecycle__in=[Channel.Lifecycle.ACTIVE, Channel.Lifecycle.PROVISIONING],
        ).exists()
        if has_conf:
            return False
        _provision_text_channel_if_absent(
            workspace=workspace,
            template_key="confidential_vault",
            default_name="confidentiel",
            is_confidential=True,
            reason="workspace.security_posture.confidential_channel",
        )
        return True

    raise RefusalError(422)


def remediate_security_posture(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    action: str,
    request_id: str,
) -> dict[str, Any]:
    if not isinstance(action, str) or action not in VALID_REMEDIATION_ACTIONS:
        raise RefusalError(422)

    with transaction.atomic():
        initial_workspace, _ = authorize_posture_admin(verified, organisation_id)
        lock_organisation_fence(organisation_id=organisation_id)
        lock_workspace(workspace_id=initial_workspace.id)
        workspace, caller = authorize_posture_admin(verified, organisation_id)
        workspace = Workspace.objects.select_for_update().get(pk=workspace.pk)

        now = timezone.now()
        before = evaluate_security_posture(_collect_facts(workspace, caller=caller, now=now))
        is_single = action != ACTION_FIX_ALL_SAFE
        candidates = ORDERED_ACTIONS if not is_single else (action,)
        applied: list[str] = []
        for candidate in candidates:
            if _apply_single_remediation(
                action=candidate,
                workspace=workspace,
                caller=caller,
                verified=verified,
                now=now,
                strict_single=is_single,
            ):
                applied.append(candidate)

        workspace.refresh_from_db()
        after = evaluate_security_posture(_collect_facts(workspace, caller=caller, now=now))
        record_workspace_resource_event(
            action="workspace.security_posture.configured",
            organisation_id=workspace.organisation_id,
            target_id=workspace.id,
            actor_id=caller.identity_id,
            request_id=request_id,
            metadata={
                "requested_action": action,
                "applied_actions": applied,
                "score_before": before.score,
                "score_after": after.score,
            },
        )
        return {
            "requested_action": action,
            "applied_actions": applied,
            "score_before": before.score,
            "posture": after.to_wire(),
        }
