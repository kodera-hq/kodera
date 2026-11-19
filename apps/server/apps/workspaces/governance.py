"""Workspace profile, channel role overrides, bans and administrative audit reads."""

import hashlib
import json
import re
from typing import Any
from uuid import UUID

from django.core import signing
from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import Q

from apps.audit.selectors import list_workspace_audit_events
from apps.orgs.actor_selectors import TenantCaller
from services.identity.access_tokens import VerifiedAccessToken

from .iam import authorize, check_manage, mutation_context, resolve_roles
from .iam_validation import validate_permissions
from .models import Channel, Workspace, WorkspaceChannelRoleOverride, WorkspaceMemberRestriction
from .moderation import ADMINS, RefusalError, _audit, _storable_text, _text
from .moderation_wire import tag

_UNSET = object()

PROFILE_TEXT = {"description", "banner_preset", "icon_mxc"}
PROFILE_CHANNELS = {
    "arrivals_channel_id",
    "rules_channel_id",
    "moderator_updates_channel_id",
    "security_alerts_channel_id",
}
PROFILE_FIELDS = PROFILE_TEXT | PROFILE_CHANNELS | {"traits", "invites_paused"}


def profile_wire(workspace: Workspace) -> dict[str, Any]:
    return {
        field: str(value) if isinstance(value := getattr(workspace, field), UUID) else value
        for field in sorted(PROFILE_FIELDS)
    }


def profile_etag(workspace: Workspace) -> str:
    return tag(
        {
            "id": str(workspace.id),
            **profile_wire(workspace),
            "updated_at": workspace.updated_at.isoformat(),
        }
    )


@transaction.atomic
def profile_with_etag(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    data: dict[str, Any] | None = None,
    if_match: str = "",
    request_id: str = "",
) -> tuple[dict[str, Any], str]:
    workspace, caller = (
        authorize(verified, organisation_id)
        if data is None
        else mutation_context(verified, organisation_id, admin=True)
    )
    if data is not None:
        token = if_match.strip()
        if not token:
            raise RefusalError(428)
        current = profile_etag(workspace)
        if token not in {"*", current}:
            raise RefusalError(412, current_etag=current)
        if not data or data.keys() - PROFILE_FIELDS:
            raise RefusalError(422)
        for field, value in data.items():
            if field in PROFILE_TEXT:
                if not isinstance(value, str) or not _storable_text(value):
                    raise RefusalError(422)
                if field == "description" and len(value) > 500:
                    raise RefusalError(422)
                if (
                    field == "banner_preset"
                    and value
                    and not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", value)
                ):
                    raise RefusalError(422)
                if (
                    field == "icon_mxc"
                    and value
                    and (
                        len(value) > 512
                        or not re.fullmatch(r"mxc://[a-zA-Z0-9.:-]+/[a-zA-Z0-9_-]+", value)
                    )
                ):
                    raise RefusalError(422)
            elif field in PROFILE_CHANNELS:
                if value is not None:
                    try:
                        value = UUID(value) if isinstance(value, str) else None
                    except ValueError:
                        raise RefusalError(422) from None
                    if value is None:
                        raise RefusalError(422)
                    if not Channel.objects.filter(
                        id=value,
                        workspace=workspace,
                        kind="text",
                        lifecycle__in=["active", "provisioning"],
                    ).exists():
                        raise RefusalError(404)
            elif field == "invites_paused":
                if type(value) is not bool:
                    raise RefusalError(422)
            elif field == "traits":
                if not isinstance(value, list) or len(value) > 5:
                    raise RefusalError(422)
                for badge in value:
                    if not isinstance(badge, dict) or badge.keys() != {"icon", "label"}:
                        raise RefusalError(422)
                    _text(badge["icon"], 32)
                    _text(badge["label"], 50)
            setattr(workspace, field, value)
        workspace.save(update_fields=[*data, "updated_at"])
        _audit(workspace, caller.identity_id, "workspace.profile.updated", workspace.id, request_id)
    return profile_wire(workspace), profile_etag(workspace)


def profile(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    data: dict[str, Any] | None = None,
    if_match: str = "",
    request_id: str = "",
) -> dict[str, Any]:
    return profile_with_etag(
        verified=verified,
        organisation_id=organisation_id,
        data=data,
        if_match=if_match,
        request_id=request_id,
    )[0]


def _check_channel_visible(workspace: Workspace, caller: TenantCaller, channel_id: UUID) -> None:
    if not Channel.objects.filter(
        id=channel_id, workspace=workspace, lifecycle__in=["active", "provisioning"]
    ).exists():
        raise RefusalError(404)
    if caller.role not in ADMINS:
        from .channel_access import may_view, resolve
        from .structure import WorkspaceUnavailableError

        try:
            access = resolve(channel_id)
        except WorkspaceUnavailableError:
            raise RefusalError(404) from None
        if not may_view(
            access,
            organisation_id=workspace.organisation_id,
            membership_id=caller.membership_id,
            authority_revision=caller.authority_revision,
        ):
            raise RefusalError(404)


@transaction.atomic
def overrides(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    channel_id: UUID,
    data: Any = _UNSET,
    request_id: str = "",
) -> dict[str, Any]:
    if data is _UNSET:
        workspace, caller = authorize(verified, organisation_id)
        _check_channel_visible(workspace, caller, channel_id)
    else:
        initial_workspace, initial_caller = authorize(verified, organisation_id, "manage_roles")
        _check_channel_visible(initial_workspace, initial_caller, channel_id)
        workspace, caller = mutation_context(verified, organisation_id, "manage_roles")
        _check_channel_visible(workspace, caller, channel_id)
    rows = WorkspaceChannelRoleOverride.objects.filter(workspace=workspace, channel_id=channel_id)
    if data is not _UNSET:
        if not isinstance(data, list) or len(data) > 100:
            raise RefusalError(422)
        normalized = []
        for entry in data:
            if not isinstance(entry, dict) or entry.keys() != {"role_id", "allow", "deny"}:
                raise RefusalError(422)
            try:
                validate_permissions(entry["allow"])
                validate_permissions(entry["deny"])
            except ValidationError:
                raise RefusalError(422) from None
            if set(entry["allow"]) & set(entry["deny"]):
                raise RefusalError(422)
            normalized.append(entry["role_id"])
        roles = resolve_roles(workspace, normalized)
        existing = list(rows.select_related("role"))
        check_manage(workspace, caller, [row.role for row in existing] + roles)
        for row in existing:
            check_manage(workspace, caller, [], permissions=[*row.allow, *row.deny])
        by_id = {str(role.id): role for role in roles}
        for entry in data:
            check_manage(workspace, caller, [], permissions=[*entry["allow"], *entry["deny"]])
        rows.delete()
        WorkspaceChannelRoleOverride.objects.bulk_create(
            [
                WorkspaceChannelRoleOverride(
                    workspace=workspace,
                    channel_id=channel_id,
                    role=by_id[str(UUID(entry["role_id"]))],
                    allow=entry["allow"],
                    deny=entry["deny"],
                )
                for entry in data
            ]
        )
        _audit(
            workspace,
            caller.identity_id,
            "workspace.channel.overrides_updated",
            channel_id,
            request_id,
        )
    return {
        "data": [
            {"role_id": str(row.role_id), "allow": row.allow, "deny": row.deny}
            for row in rows.order_by("role_id")
        ]
    }


@transaction.atomic
def admin_page(
    *, verified: VerifiedAccessToken, organisation_id: UUID, kind: str, query: dict[str, str]
) -> dict[str, Any]:
    from .moderation_wire import _select

    workspace, caller = authorize(
        verified, organisation_id, "view_audit_log" if kind == "audit" else None
    )
    if kind == "bans" and caller.role not in ADMINS:
        raise RefusalError(403)
    allowed = {"cursor", "limit"} | ({"q"} if kind == "bans" else {"actor_id", "action"})
    if query.keys() - allowed:
        raise RefusalError(400)
    try:
        limit = int(query.get("limit", "50"))
    except ValueError:
        raise RefusalError(400) from None
    if not 1 <= limit <= 200:
        raise RefusalError(400)
    salt = (
        f"workspace-admin:{workspace.id}:{caller.membership_id}:{kind}:"
        + hashlib.sha256(
            json.dumps(
                {key: query[key] for key in sorted(query) if key not in {"cursor", "limit"}},
                sort_keys=True,
            ).encode()
        ).hexdigest()
    )
    if kind == "bans":
        search = query.get("q", "")
        if len(search) > 100 or not _storable_text(search):
            raise RefusalError(400)
        bans = WorkspaceMemberRestriction.objects.filter(
            workspace=workspace, banned=True
        ).select_related("membership__user")
        if search:
            bans = bans.filter(
                Q(membership__user__email__icontains=search)
                | Q(membership__user__display_name__icontains=search)
            )
        return _select(
            bans,
            lambda row: {
                "id": str(row.id),
                "membership_id": str(row.membership_id),
                "display_name": row.membership.user.display_name,
                "email": row.membership.user.email,
                "updated_at": row.updated_at.isoformat(),
            },
            query.get("cursor"),
            limit,
            salt,
        )
    actor_id: UUID | None = None
    if "actor_id" in query:
        try:
            actor_id = UUID(query["actor_id"])
        except ValueError:
            raise RefusalError(400) from None
    action: str | None = None
    if "action" in query:
        if not re.fullmatch(r"[a-z][a-z0-9_.]{0,99}", query["action"]):
            raise RefusalError(400)
        action = query["action"]
    anchor: UUID | None = None
    cursor = query.get("cursor")
    if cursor is not None:
        if not cursor or len(cursor) > 512:
            raise RefusalError(400)
        try:
            anchor = UUID(signing.loads(cursor, salt=salt, max_age=3600))
        except (signing.BadSignature, ValueError, TypeError):
            raise RefusalError(400) from None
    selected = list_workspace_audit_events(
        organisation_id=organisation_id,
        limit=limit,
        actor_id=actor_id,
        action=action,
        before_id=anchor,
    )
    more = len(selected) > limit
    selected = selected[:limit]
    # Audit payloads may contain sensitive evidence; the admin table exposes identifiers only.
    return {
        "data": [
            {
                "id": str(event.id),
                "occurred_at": event.occurred_at.isoformat(),
                "actor_id": str(event.actor_id) if event.actor_id else None,
                "actor_type": event.actor_type,
                "action": event.action,
                "target_urn": event.target_urn,
                "request_id": event.request_id,
            }
            for event in selected
        ],
        "has_more": more,
        "next_cursor": signing.dumps(str(selected[-1].id), salt=salt) if more else None,
    }
