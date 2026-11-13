"""Current-principal inbox operations and sealed device subscriptions."""

import hashlib
import json
from typing import Any
from uuid import UUID, uuid4

from django.apps import apps
from django.conf import settings
from django.core import signing
from django.core.exceptions import ObjectDoesNotExist
from django.db import IntegrityError, connection, transaction
from django.utils import timezone

from apps.media.context import RefusalError as RefusalError, audit, caller
from apps.orgs.actor_selectors import TenantCaller
from apps.orgs.workspace_members import for_workspace
from core import sealing
from services.identity.access_tokens import VerifiedAccessToken

from . import push
from .models import Notification, PushOutbox, PushSubscription


def seal_key() -> bytes:
    value = getattr(settings, "KODERA_NOTIFICATION_SEAL_KEY", None)
    if not isinstance(value, bytes) or len(value) != 32:
        raise RefusalError(503, "service-unavailable")
    return value


def associated(row: PushSubscription) -> bytes:
    return f"kodera-push:v1:{row.id}:{row.organisation_id}:{row.membership_id}:{row.device_id}:{row.version}".encode()


def subscription_data(row: PushSubscription) -> dict[str, str]:
    try:
        result = json.loads(
            sealing.unseal(seal_key(), associated(row), bytes(row.sealed_subscription))
        )
        if (
            not isinstance(result, dict)
            or set(result) != {"endpoint", "p256dh", "auth"}
            or not all(isinstance(v, str) for v in result.values())
        ):
            raise ValueError
        return result
    except (ValueError, sealing.SealError):
        raise RefusalError(503, "service-unavailable") from None


def public_key() -> str:
    value = getattr(settings, "KODERA_PUSH_VAPID_PUBLIC_KEY", None)
    if not isinstance(value, str):
        raise RefusalError(503, "service-unavailable")
    try:
        push.point(value)
    except (ValueError, TypeError):
        raise RefusalError(503, "service-unavailable") from None
    return value


@transaction.atomic
def put_subscription(
    *, verified: VerifiedAccessToken, device_id: UUID, body: dict[str, Any], request_id: str
) -> None:
    principal = caller(verified)
    public_key()
    key = seal_key()
    try:
        endpoint = push.subscription(body["endpoint"], body["p256dh"], body["auth"])
    except ValueError:
        raise RefusalError(422) from None
    material = {"endpoint": endpoint, "p256dh": body["p256dh"], "auth": body["auth"]}
    # Membership serializes initial device registration as well as replacements.
    if (
        for_workspace(
            organisation_id=principal.organisation_id, membership_id=principal.membership_id
        )
        is None
    ):
        raise RefusalError(403)
    row = (
        PushSubscription.objects.select_for_update()
        .filter(
            organisation_id=principal.organisation_id,
            membership_id=principal.membership_id,
            device_id=device_id,
        )
        .first()
    )
    if row is not None and row.revoked_at is None:
        try:
            if subscription_data(row) == material:
                return
        except RefusalError:
            pass  # An authenticated replacement may reseal after application-key rotation.
    if row is None:
        row = PushSubscription(
            organisation_id=principal.organisation_id,
            membership_id=principal.membership_id,
            device_id=device_id,
        )
    row.version, row.revoked_at = uuid4(), None
    row.endpoint_digest = hashlib.sha256(endpoint.encode()).hexdigest()
    row.sealed_subscription = sealing.seal(
        key, associated(row), json.dumps(material, separators=(",", ":")).encode()
    )
    try:
        with transaction.atomic():
            if row._state.adding:
                row.save(force_insert=True)
            else:
                row.save(
                    update_fields=[
                        "version",
                        "revoked_at",
                        "endpoint_digest",
                        "sealed_subscription",
                        "updated_at",
                    ]
                )
    except IntegrityError:
        raise RefusalError(409) from None
    audit(principal, "workspace.push_subscription.updated", row.id, request_id)


@transaction.atomic
def delete_subscription(*, verified: VerifiedAccessToken, device_id: UUID, request_id: str) -> None:
    principal = caller(verified)
    row = (
        PushSubscription.objects.select_for_update()
        .filter(
            organisation_id=principal.organisation_id,
            membership_id=principal.membership_id,
            device_id=device_id,
        )
        .first()
    )
    if row is not None and row.revoked_at is None:
        row.revoked_at = timezone.now()
        row.version = uuid4()
        row.save(update_fields=["revoked_at", "version", "updated_at"])
        audit(principal, "workspace.push_subscription.revoked", row.id, request_id)


def wire(row: Notification) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "kind": row.kind,
        "resourceId": str(row.resource_id),
        "createdAt": row.created_at.isoformat(),
        "readAt": row.read_at.isoformat() if row.read_at else None,
    }


def visible(row: Notification, principal: TenantCaller, verified: VerifiedAccessToken) -> bool:
    if row.kind == "moderation":
        return row.resource_id == principal.membership_id
    if row.kind == "mention":
        from apps.workspaces.channel_access import may_view, resolve
        from apps.workspaces.structure import WorkspaceUnavailableError

        if not Notification.objects.filter(
            pk=row.id,
            organisation_id=principal.organisation_id,
            organisation__workspace__channel__id=row.resource_id,
        ).exists():
            return False
        try:
            access = resolve(row.resource_id)
        except (ObjectDoesNotExist, WorkspaceUnavailableError):
            return False
        return may_view(
            access,
            organisation_id=principal.organisation_id,
            membership_id=principal.membership_id,
            authority_revision=principal.authority_revision,
        )
    if row.kind == "document":
        if not apps.is_installed("apps.docs"):
            return False
        # A missing document-policy adapter fails closed until the docs application is installed.
        try:
            from apps.docs.access import document_visible
        except ImportError:
            return False
        return bool(document_visible(principal, row.resource_id, verified=verified))
    return row.kind == "invitation"


@transaction.atomic
def inbox(*, verified: VerifiedAccessToken, cursor: str | None, limit: int) -> dict[str, Any]:
    principal = caller(verified)
    if type(limit) is not int or not 1 <= limit <= 200:
        raise RefusalError(400)
    salt = f"notification-inbox:v1:{principal.organisation_id}:{principal.membership_id}:{verified.issuer}:{verified.subject}"
    rows = Notification.objects.filter(
        organisation_id=principal.organisation_id, membership_id=principal.membership_id
    )
    if cursor is not None:
        if not cursor or len(cursor) > 512:
            raise RefusalError(400)
        try:
            anchor = UUID(signing.loads(cursor, salt=salt, max_age=3600))
        except (ValueError, TypeError, signing.BadSignature):
            raise RefusalError(400) from None
        rows = rows.filter(id__lt=anchor)
    # Scan a bounded window. A page can be short when policy has hidden old resources;
    # its cursor advances past that window so repeated requests still make progress.
    scanned = list(rows.order_by("-id")[: limit + 1])
    more = len(scanned) > limit
    selected = scanned[:limit]
    return {
        "data": [wire(row) for row in selected if visible(row, principal, verified)],
        "has_more": more,
        "next_cursor": signing.dumps(str(selected[-1].id), salt=salt) if more else None,
    }


@transaction.atomic
def mark_read(*, verified: VerifiedAccessToken, ids: list[UUID], request_id: str) -> None:
    principal = caller(verified)
    if (
        not isinstance(ids, list)
        or not 1 <= len(ids) <= 200
        or not all(isinstance(i, UUID) for i in ids)
        or len(set(ids)) != len(ids)
    ):
        raise RefusalError(422)
    rows = Notification.objects.select_for_update().filter(
        organisation_id=principal.organisation_id, membership_id=principal.membership_id, id__in=ids
    )
    selected = list(rows)
    if len(selected) != len(ids) or not all(visible(row, principal, verified) for row in selected):
        raise RefusalError(404)
    rows.filter(read_at__isnull=True).update(read_at=timezone.now(), updated_at=timezone.now())
    audit(principal, "workspace.notification.read", principal.membership_id, request_id)


def record(
    *, organisation_id: UUID, membership_id: UUID, kind: str, resource_id: UUID
) -> Notification:
    """Internal producer. Its caller authorizes the referenced resource in this transaction."""
    if not connection.in_atomic_block:
        raise RuntimeError("notification creation belongs to the producer's transaction")
    if kind not in {"mention", "invitation", "moderation", "document"} or not isinstance(
        resource_id, UUID
    ):
        raise ValueError("notification kind or resource refused")
    if for_workspace(organisation_id=organisation_id, membership_id=membership_id) is None:
        raise ValueError("notification recipient refused")
    row = Notification.objects.create(
        organisation_id=organisation_id,
        membership_id=membership_id,
        kind=kind,
        resource_id=resource_id,
    )
    now = timezone.now()
    PushOutbox.objects.bulk_create(
        [
            PushOutbox(subscription=sub, subscription_version=sub.version, available_at=now)
            for sub in PushSubscription.objects.filter(
                organisation_id=organisation_id,
                membership_id=membership_id,
                revoked_at__isnull=True,
            )
        ]
    )
    return row


@transaction.atomic
def authorize(verified: VerifiedAccessToken, organisation_id: UUID | None = None) -> None:
    caller(verified, organisation_id)


def record_moderation(*, organisation_id: UUID, membership_id: UUID) -> None:
    """Explicit producer port, called in the moderation audit writer's transaction."""
    if not connection.in_atomic_block:
        raise RuntimeError("moderation notification belongs to its producer transaction")
    if for_workspace(organisation_id=organisation_id, membership_id=membership_id) is not None:
        record(
            organisation_id=organisation_id,
            membership_id=membership_id,
            kind="moderation",
            resource_id=membership_id,
        )
