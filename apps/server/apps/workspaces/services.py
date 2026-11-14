"""Public workspace service ports; policy construction performs no request or database work."""

from uuid import UUID

from core.api.guarded_replay import EffectPolicy


def quota_replay_policy() -> EffectPolicy:
    from .quota_http import QuotaReplayPolicy

    return QuotaReplayPolicy()


def sync_subscription_quota(
    *,
    organisation_id: UUID,
    policy_ref: str,
    seats: int | None,
    media_bytes: int | None = None,
    pages: int | None = None,
    update_storage: bool = False,
) -> UUID | None:
    """Synchronize an organisation's WorkspaceQuota from reconciled subscription state."""
    from .models import Workspace, WorkspaceQuota

    if seats is not None and seats < 0:
        raise ValueError("seats quota must be non-negative")
    workspace = Workspace.objects.filter(organisation_id=organisation_id).first()
    if workspace is None:
        return None
    quota = WorkspaceQuota.objects.select_for_update().filter(workspace=workspace).first()
    if quota is None:
        quota = WorkspaceQuota.objects.create(
            workspace=workspace,
            policy_ref=policy_ref,
            seats=seats,
            media_bytes=media_bytes if update_storage else None,
            pages=pages if update_storage else None,
        )
        return quota.id
    quota.policy_ref = policy_ref
    quota.seats = seats
    update_fields = ["policy_ref", "seats", "updated_at"]
    if update_storage:
        quota.media_bytes = media_bytes
        quota.pages = pages
        update_fields.extend(["media_bytes", "pages"])
    quota.save(update_fields=update_fields)
    return quota.id
