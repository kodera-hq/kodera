"""Issuer-bound moderation and serialized reusable invite redemption."""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from django.db import transaction
from django.db.models import F
from django.utils import timezone

from apps.audit.services import record_workspace_resource_event
from apps.identity.selectors import IdentitySnapshot, PersonSnapshot, current_identity
from apps.orgs.actor_selectors import (
    TenantCaller,
    TenantCallerNotFoundError,
    TenantCallerUnknownError,
    read_tenant_caller,
)
from apps.orgs.workspace_members import (
    WorkspaceMembership,
    create_from_workspace_link,
    for_user,
    for_workspace,
)
from services.identity.access_tokens import VerifiedAccessToken

from .models import (
    Channel,
    Workspace,
    WorkspaceAbuseReport,
    WorkspaceInviteLink,
    WorkspaceInviteRedemption,
    WorkspaceMemberRestriction,
    WorkspaceModerator,
)
from .moderation_policy import target_allowed

ADMINS = frozenset({"org_owner", "org_admin"})


class RefusalError(Exception):
    def __init__(self, status: int, kind: str | None = None) -> None:
        super().__init__("workspace action refused")
        self.status = status
        self.kind = (
            kind
            or {
                400: "malformed-request",
                403: "forbidden",
                404: "not-found",
                409: "conflict",
                412: "precondition-failed",
                422: "validation-error",
                428: "precondition-required",
            }[status]
        )


def _audit(
    workspace: Workspace, actor_id: UUID, action: str, target: UUID, request_id: str
) -> None:
    record_workspace_resource_event(
        action=action,
        actor_id=actor_id,
        organisation_id=workspace.organisation_id,
        target_id=target,
        request_id=request_id,
    )


def _context(
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    *,
    moderator: bool = False,
    admin: bool = False,
) -> tuple[Workspace, TenantCaller]:
    # Domain rows first; this same lock serializes grant/restriction changes and projection.
    workspace = (
        Workspace.objects.select_for_update().filter(organisation_id=organisation_id).first()
    )
    if workspace is None:
        raise RefusalError(404)
    try:
        caller = read_tenant_caller(
            verified=verified, organisation_id=organisation_id, allow_community=True
        )
    except TenantCallerUnknownError:
        raise RefusalError(403, "identity-unknown") from None
    except TenantCallerNotFoundError:
        raise RefusalError(404) from None
    if caller.organisation_state != "active":
        raise RefusalError(403)
    denied, _ = member_restrictions(workspace.id, caller.membership_id)
    if denied:
        raise RefusalError(403)
    if admin and caller.role not in ADMINS:
        raise RefusalError(403)
    if (
        moderator
        and caller.role not in ADMINS
        and not WorkspaceModerator.objects.filter(
            workspace=workspace, membership_id=caller.membership_id
        ).exists()
    ):
        raise RefusalError(403)
    return workspace, caller


@transaction.atomic
def authorise_workspace(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    moderator: bool = False,
    admin: bool = False,
) -> TenantCaller:
    """Current workspace admission as an immutable caller, without leaking a stored model."""
    return _context(verified, organisation_id, moderator=moderator, admin=admin)[1]


def member_restrictions(
    workspace_id: UUID, membership_id: UUID, *, now: datetime | None = None
) -> tuple[bool, bool]:
    row = (
        WorkspaceMemberRestriction.objects.filter(
            workspace_id=workspace_id, membership_id=membership_id
        )
        .values_list("banned", "kicked", "muted_until")
        .first()
    )
    if row is None:
        return False, False
    return row[0] or row[1], row[2] is not None and row[2] > (now or timezone.now())


def _target(workspace: Workspace, membership_id: UUID) -> WorkspaceMembership:
    member = for_workspace(organisation_id=workspace.organisation_id, membership_id=membership_id)
    if member is None:
        raise RefusalError(404)
    return member


def _storable_text(value: str) -> bool:
    return all(char != "\x00" and not 0xD800 <= ord(char) <= 0xDFFF for char in value)


def _text(value: Any, maximum: int) -> str:
    if (
        not isinstance(value, str)
        or not value.strip()
        or len(value) > maximum
        or not _storable_text(value)
    ):
        raise RefusalError(422)
    return value


def _expiry(value: datetime | None) -> datetime:
    now = timezone.now()
    if (
        not isinstance(value, datetime)
        or timezone.is_naive(value)
        or not now < value <= now + timedelta(days=30)
    ):
        raise RefusalError(422)
    return value


def _emit(workspace: Workspace, reason: str) -> None:
    from .channel_sets import emit_for

    emit_for(organisation_id=workspace.organisation_id, workspace_id=workspace.id, reason=reason)


@transaction.atomic
def moderate(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    target_id: UUID,
    action: str,
    reason: str,
    expires_at: datetime | None,
    request_id: str,
) -> dict[str, Any]:
    workspace, caller = _context(verified, organisation_id, moderator=True)
    target = _target(workspace, target_id)
    if not target_allowed(caller.role, target.role, action) or target.id == caller.membership_id:
        raise RefusalError(403)
    if not isinstance(action, str) or action not in {"kick", "ban", "unban", "mute"}:
        raise RefusalError(422)
    _text(reason, 2000)
    if action == "mute":
        expires_at = _expiry(expires_at)
    elif expires_at is not None:
        raise RefusalError(422)
    row, _ = WorkspaceMemberRestriction.objects.get_or_create(
        workspace=workspace, membership_id=target.id
    )
    if action == "mute":
        row.muted_until = expires_at
    elif action == "unban":
        row.banned = row.kicked = False
    else:
        row.kicked = True
        if action == "ban":
            row.banned = True
    row.save(update_fields=["banned", "kicked", "muted_until", "updated_at"])
    _audit(workspace, caller.identity_id, "workspace.member." + action, target.id, request_id)
    _emit(workspace, "workspace.member." + action)
    return {
        "id": str(row.id),
        "membershipId": str(target.id),
        "action": action,
        "expiresAt": expires_at.isoformat() if expires_at else None,
        "createdAt": row.updated_at.isoformat(),
    }


@transaction.atomic
def create_link(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    expires_at: datetime,
    max_uses: int,
    role: str,
    channel_id: UUID | None,
    request_id: str,
) -> tuple[WorkspaceInviteLink, str]:
    workspace, caller = _context(verified, organisation_id, admin=True)
    _expiry(expires_at)
    if (
        type(max_uses) is not int
        or not 1 <= max_uses <= 10000
        or not isinstance(role, str)
        or role not in {"org_member", "moderator"}
    ):
        raise RefusalError(422)
    channel = None
    if channel_id is not None:
        channel = Channel.objects.filter(
            id=channel_id, workspace=workspace, lifecycle__in=["active", "provisioning"]
        ).first()
        if channel is None:
            raise RefusalError(404)
    code = secrets.token_urlsafe(32)
    link = WorkspaceInviteLink.objects.create(
        workspace=workspace,
        code_digest=hashlib.sha256(code.encode()).hexdigest(),
        expires_at=expires_at,
        max_uses=max_uses,
        role=role,
        channel=channel,
    )
    _audit(workspace, caller.identity_id, "workspace.invite_link.created", link.id, request_id)
    return link, code


def _link(code: str, *, lock: bool = False, allow_exhausted: bool = False) -> WorkspaceInviteLink:
    if not isinstance(code, str) or not 1 <= len(code) <= 256:
        raise RefusalError(404)
    rows = WorkspaceInviteLink.objects.select_related("workspace__organisation")
    if lock:
        rows = rows.select_for_update(of=("self",))
    link = rows.filter(code_digest=hashlib.sha256(code.encode()).hexdigest()).first()
    if (
        link is None
        or link.revoked_at is not None
        or link.expires_at <= timezone.now()
        or (not allow_exhausted and link.uses_count >= link.max_uses)
    ):
        raise RefusalError(404)
    return link


def _identity(
    verified: VerifiedAccessToken, link: WorkspaceInviteLink
) -> tuple[PersonSnapshot, IdentitySnapshot]:
    organisation = link.workspace.organisation
    resolved = current_identity(issuer=verified.issuer, subject=verified.subject)
    if (
        organisation.state != "active"
        or organisation.deleted_at is not None
        or verified.issuer != organisation.issuer
        or not verified.email_verified
        or resolved is None
        or resolved[1].organisation_id != organisation.id
    ):
        raise RefusalError(404)
    return resolved


@transaction.atomic
def preview_link(*, verified: VerifiedAccessToken, code: str) -> WorkspaceInviteLink:
    link = _link(code)
    _identity(verified, link)
    return link


@transaction.atomic
def redeem_link(
    *, verified: VerifiedAccessToken, code: str, request_id: str
) -> WorkspaceMembership:
    # Look up without locking, then take the domain lock before the link row and engine heads.
    initial = _link(code, allow_exhausted=True)
    workspace = Workspace.objects.select_for_update().get(id=initial.workspace_id)
    link = _link(code, lock=True, allow_exhausted=True)
    person, identity = _identity(verified, link)
    membership = for_user(organisation_id=workspace.organisation_id, user_id=person.id, lock=True)
    if membership is not None:
        if membership.state != "active" or membership.accepted_at is None:
            raise RefusalError(403)
        restriction = (
            WorkspaceMemberRestriction.objects.select_for_update()
            .filter(workspace=workspace, membership_id=membership.id)
            .first()
        )
        if restriction is not None and restriction.banned:
            raise RefusalError(403)
        redeemed = WorkspaceInviteRedemption.objects.filter(
            link=link, membership_id=membership.id
        ).exists()
        if redeemed:
            if restriction is not None and restriction.kicked:
                raise RefusalError(403)
            return membership
        if restriction is not None and restriction.kicked:
            restriction.kicked = False
            restriction.save(update_fields=["kicked", "updated_at"])
    else:
        membership = create_from_workspace_link(
            organisation_id=workspace.organisation_id, user_id=person.id
        )
    # The row lock is the concurrency boundary; the conditional update is a second guard.
    updated = WorkspaceInviteLink.objects.filter(
        pk=link.pk,
        revoked_at__isnull=True,
        expires_at__gt=timezone.now(),
        uses_count__lt=F("max_uses"),
    ).update(uses_count=F("uses_count") + 1)
    if updated != 1:
        raise RefusalError(404)
    WorkspaceInviteRedemption.objects.get_or_create(link=link, membership_id=membership.id)
    if link.role == "moderator":
        WorkspaceModerator.objects.get_or_create(workspace=workspace, membership_id=membership.id)
    if link.channel_id is not None:
        _grant_link_channel(workspace, link.channel_id, membership)
        _audit(
            workspace,
            identity.id,
            "workspace.invite_link.channel_granted",
            link.channel_id,
            request_id,
        )
    _audit(workspace, identity.id, "workspace.invite_link.redeemed", link.id, request_id)
    from apps.engine_intents.services import emit_member_set

    emit_member_set(organisation_id=workspace.organisation_id, reason="member_joined")
    _emit(workspace, "workspace.invite_link.redeemed")
    return membership


@transaction.atomic
def revoke_link(
    *, verified: VerifiedAccessToken, organisation_id: UUID, link_id: UUID, request_id: str
) -> None:
    workspace, caller = _context(verified, organisation_id, admin=True)
    link = (
        WorkspaceInviteLink.objects.select_for_update()
        .filter(id=link_id, workspace=workspace)
        .first()
    )
    if link is None:
        raise RefusalError(404)
    if link.revoked_at is None:
        link.revoked_at = timezone.now()
        link.save(update_fields=["revoked_at", "updated_at"])
        _audit(workspace, caller.identity_id, "workspace.invite_link.revoked", link.id, request_id)


@transaction.atomic
def report(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    target_id: UUID,
    reason: str,
    channel_id: UUID | None,
    event_id: str,
    request_id: str,
) -> WorkspaceAbuseReport:
    workspace, caller = _context(verified, organisation_id)
    target = _target(workspace, target_id)
    _text(reason, 4000)
    if not isinstance(event_id, str) or len(event_id) > 512 or not _storable_text(event_id):
        raise RefusalError(422)
    if channel_id is not None:
        from .channel_access import may_view, resolve

        channel = Channel.objects.filter(id=channel_id, workspace=workspace).first()
        if channel is None or not may_view(
            resolve(channel.id),
            organisation_id=workspace.organisation_id,
            membership_id=caller.membership_id,
            authority_revision=caller.authority_revision,
        ):
            raise RefusalError(404)
    row = WorkspaceAbuseReport.objects.create(
        workspace=workspace,
        reporter_id=caller.membership_id,
        membership_id=target.id,
        reason=reason,
        channel_id=channel_id,
        event_id=event_id,
    )
    _audit(workspace, caller.identity_id, "workspace.report.created", row.id, request_id)
    return row


@transaction.atomic
def resolve_report(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    report_id: UUID,
    status: str,
    resolution: str,
    if_match: str,
    request_id: str,
) -> WorkspaceAbuseReport:
    from .moderation_wire import report_wire, tag

    workspace, caller = _context(verified, organisation_id, moderator=True)
    row = (
        WorkspaceAbuseReport.objects.select_for_update()
        .filter(pk=report_id, workspace=workspace)
        .first()
    )
    if row is None:
        raise RefusalError(404)
    if not if_match:
        raise RefusalError(428)
    if if_match not in {"*", tag(report_wire(row))}:
        raise RefusalError(412)
    if not isinstance(status, str) or status not in {"resolved", "dismissed"}:
        raise RefusalError(422)
    _text(resolution, 4000)
    if row.status != "open":
        raise RefusalError(409)
    row.status, row.resolution, row.resolved_by_id = status, resolution, caller.membership_id
    row.save(update_fields=["status", "resolution", "resolved_by_id", "updated_at"])
    _audit(workspace, caller.identity_id, "workspace.report." + status, row.id, request_id)
    return row


def projection(workspace_id: UUID) -> dict[str, Any]:
    workspace = Workspace.objects.get(pk=workspace_id)
    rows = list(
        WorkspaceMemberRestriction.objects.filter(workspace=workspace).select_related("membership")
    )
    if not rows:
        return {}
    from apps.identity.selectors import realm_subjects

    by_user: dict[UUID, set[str]] = {}
    # A disabled identity can still have an older Matrix session. Keep its
    # subject in removal and mute facts until the workspace restriction is lifted.
    for user_id, subject, _usable in realm_subjects(organisation_id=workspace.organisation_id):
        by_user.setdefault(user_id, set()).add(subject)
    banned = set()
    muted: list[dict[str, str]] = []
    for row in rows:
        subjects = by_user.get(row.membership.user_id, set())
        if row.banned or row.kicked:
            banned.update(subjects)
        if row.muted_until is not None and row.muted_until > timezone.now():
            muted.extend(
                {"subject": subject, "expires_at": row.muted_until.isoformat()}
                for subject in subjects
            )
    return {
        "banned_subjects": sorted(banned),
        "muted_subjects": sorted(muted, key=lambda item: item["subject"]),
    }


@transaction.atomic
def admit_redemption(*, verified: VerifiedAccessToken, code: str) -> None:
    link = _link(code, allow_exhausted=True)
    person, identity = _identity(verified, link)
    member = for_user(organisation_id=link.workspace.organisation_id, user_id=person.id)
    if member is not None and (member.state != "active" or member.accepted_at is None):
        raise RefusalError(403)
    redeemed = (
        member is not None
        and WorkspaceInviteRedemption.objects.filter(link=link, membership_id=member.id).exists()
    )
    if not redeemed and link.uses_count >= link.max_uses:
        raise RefusalError(404)
    if member is not None:
        restriction = WorkspaceMemberRestriction.objects.filter(
            workspace_id=link.workspace_id, membership_id=member.id
        ).first()
        if restriction is not None and restriction.banned:
            raise RefusalError(403)
        if restriction is not None and restriction.kicked and redeemed:
            raise RefusalError(403)


def _grant_link_channel(
    workspace: Workspace, channel_id: UUID, membership: WorkspaceMembership
) -> None:
    from .channel_access import VIEW, may_view, resolve
    from .models import ResourcePolicy, ResourcePolicyRule

    channel = Channel.objects.select_for_update().get(pk=channel_id, workspace=workspace)
    access = resolve(channel.id)
    if (
        access.lifecycle not in {"active", "provisioning"}
        or VIEW in access.denied
        or membership.id in access.deny_members
    ):
        raise RefusalError(403)
    if not may_view(
        access,
        organisation_id=workspace.organisation_id,
        membership_id=membership.id,
        authority_revision=workspace.organisation.authority_revision,
    ):
        if channel.policy_mode == Channel.PolicyMode.INHERIT:
            policy = ResourcePolicy.objects.create(
                workspace=workspace, visibility=access.visibility
            )
            for rule in ResourcePolicyRule.objects.filter(policy_id=access.policy_id):
                ResourcePolicyRule.objects.create(
                    policy=policy,
                    kind=rule.kind,
                    membership_id=rule.membership_id,
                    capability=rule.capability,
                )
            Channel.objects.filter(pk=channel.pk).update(
                explicit_policy=policy,
                policy_mode=Channel.PolicyMode.EXPLICIT,
                version=F("version") + 1,
                updated_at=timezone.now(),
            )
        else:
            policy = ResourcePolicy.objects.get(pk=access.policy_id, workspace=workspace)
        ResourcePolicyRule.objects.get_or_create(
            policy=policy, membership_id=membership.id, kind=ResourcePolicyRule.Kind.ALLOW_MEMBER
        )
