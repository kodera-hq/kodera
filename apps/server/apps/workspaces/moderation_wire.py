"""Bounded, subject-bound cursor pages and public moderation representations."""

import hashlib
import json
from collections.abc import Callable
from typing import Any
from uuid import UUID

from django.core import signing
from django.db import transaction
from django.db.models import QuerySet

from core.db.models import StoredModel
from services.identity.access_tokens import VerifiedAccessToken

from .models import WorkspaceAbuseReport, WorkspaceInviteLink
from .moderation import RefusalError, _context


def tag(body: dict[str, Any]) -> str:
    return (
        '"'
        + hashlib.sha256(
            json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        + '"'
    )


def link_wire(row: WorkspaceInviteLink) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "expiresAt": row.expires_at.isoformat(),
        "maxUses": row.max_uses,
        "usesCount": row.uses_count,
        "revokedAt": row.revoked_at.isoformat() if row.revoked_at else None,
        "channelId": str(row.channel_id) if row.channel_id else None,
        "role": row.role,
    }


def report_wire(row: WorkspaceAbuseReport) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "membershipId": str(row.membership_id),
        "reason": row.reason,
        "status": row.status,
        "resolution": row.resolution,
        "createdAt": row.created_at.isoformat(),
    }


@transaction.atomic
def page(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    kind: str,
    cursor: str | None,
    limit: int,
    status: str = "all",
) -> dict[str, Any]:
    workspace, caller = _context(
        verified, organisation_id, moderator=kind == "reports", admin=kind == "links"
    )
    if type(limit) is not int or not 1 <= limit <= 200 or kind not in {"reports", "links"}:
        raise RefusalError(400)
    salt = f"workspace-page:{kind}:{workspace.id}:{caller.membership_id}:{status}"
    if kind == "reports":
        return _select(
            WorkspaceAbuseReport.objects.filter(workspace=workspace),
            report_wire,
            cursor,
            limit,
            salt,
        )
    links = WorkspaceInviteLink.objects.filter(workspace=workspace)
    from django.db.models import F
    from django.utils import timezone

    if status == "active":
        links = links.filter(
            revoked_at__isnull=True, expires_at__gt=timezone.now(), uses_count__lt=F("max_uses")
        )
    elif status == "revoked":
        links = links.filter(revoked_at__isnull=False)
    elif status != "all":
        raise RefusalError(400)
    return _select(links, link_wire, cursor, limit, salt)


def _select[Row: StoredModel](
    rows: QuerySet[Row],
    encode: Callable[[Row], dict[str, Any]],
    cursor: str | None,
    limit: int,
    salt: str,
) -> dict[str, Any]:
    if cursor is not None:
        if not cursor or len(cursor) > 512:
            raise RefusalError(400)
        try:
            anchor = UUID(signing.loads(cursor, salt=salt, max_age=3600))
        except (signing.BadSignature, ValueError, TypeError):
            raise RefusalError(400) from None
        rows = rows.filter(id__lt=anchor)
    selected = list(rows.order_by("-id")[: limit + 1])
    more = len(selected) > limit
    selected = selected[:limit]
    return {
        "data": [encode(row) for row in selected],
        "has_more": more,
        "next_cursor": signing.dumps(str(selected[-1].id), salt=salt) if more else None,
    }
