"""Quota policy reads and database refusal decoding, without reinterpretation of sizing guides."""

import json
from typing import Any

from django.db import connection, transaction
from django.utils import timezone

from apps.docs import services

from .models import WorkspaceQuota


def is_guard(error: Exception) -> bool:
    return getattr(getattr(error.__cause__, "diag", None), "constraint_name", None) in {
        "workspace_quota_exceeded",
        "workspace_quota_missing",
    }


def violation(error: Exception) -> dict[str, Any] | None:
    cause = error.__cause__
    diag = getattr(cause, "diag", None)
    if diag is None or getattr(diag, "constraint_name", None) != "workspace_quota_exceeded":
        return None
    try:
        detail = json.loads(diag.message_detail)
    except (ValueError, TypeError):
        return None
    if not isinstance(detail, dict) or detail.keys() != {
        "quota_key",
        "limit",
        "used",
        "requested",
        "remaining",
        "status",
    }:
        return None
    if detail["quota_key"] not in {"seats", "mediaBytes", "pages", "snapshotBytes"} or detail[
        "status"
    ] not in {402, 413, 429}:
        return None
    if any(
        type(detail[key]) is not int or detail[key] < 0
        for key in ("limit", "used", "requested", "remaining")
    ):
        return None
    return detail


@transaction.atomic
def read(*, verified, organisation_id):
    workspace_id, _ = services.context(verified, organisation_id)
    policy = WorkspaceQuota.objects.filter(workspace_id=workspace_id).first()
    if policy is None:
        raise services.RefusalError(503, "service-unavailable")
    with connection.cursor() as cursor:
        cursor.execute("SELECT workspace_quota_usage(%s)", [workspace_id])
        usage = cursor.fetchone()[0]
    try:
        usage = json.loads(usage) if isinstance(usage, str) else usage
        if (
            not isinstance(usage, dict)
            or usage.keys() != {"seats", "mediaBytes", "pages"}
            or any(type(value) is not int or value < 0 for value in usage.values())
        ):
            raise ValueError
    except (ValueError, TypeError):
        raise services.RefusalError(503, "service-unavailable") from None
    return {
        "usage": usage,
        "limits": {"seats": policy.seats, "mediaBytes": policy.media_bytes, "pages": policy.pages},
        "measuredAt": timezone.now().isoformat(),
    }
