"""Current-principal inbox operations, foreground presence leases and sealed device subscriptions."""

import hashlib
import json
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from django.apps import apps
from django.conf import settings
from django.core import signing
from django.db import IntegrityError, connection, transaction
from django.utils import timezone

from apps.media import outbound
from apps.media.context import RefusalError as RefusalError, audit, caller, read_caller
from apps.orgs.actor_selectors import TenantCaller
from apps.orgs.selectors import lock_erasure_cutoff_fences
from apps.orgs.workspace_members import for_workspace
from core import sealing
from services.identity.access_tokens import VerifiedAccessToken

from . import push
from .models import (
    NOTIFICATION_KINDS,
    Notification,
    PersonalReminder,
    PresenceLease,
    PushOutbox,
    PushSubscription,
)

PUSH_PLATFORMS: tuple[str, ...] = ("web", "desktop", "ios", "android")
FOREGROUND_PRESENCE_PLATFORMS: tuple[str, ...] = ("web", "desktop")
MOBILE_PUSH_PLATFORMS: tuple[str, ...] = ("ios", "android")
DEFAULT_PRESENCE_TTL_SECONDS = 60
MAX_PRESENCE_TTL_SECONDS = 90


def seal_key() -> bytes:
    value = getattr(settings, "KODERA_NOTIFICATION_SEAL_KEY", None)
    if not isinstance(value, bytes) or len(value) != 32:
        raise RefusalError(503, "service-unavailable")
    return value


def associated_v1(row: PushSubscription) -> bytes:
    return f"kodera-push:v1:{row.id}:{row.organisation_id}:{row.membership_id}:{row.device_id}:{row.version}".encode()


def associated(row: PushSubscription) -> bytes:
    return (
        f"kodera-push:v2:{row.id}:{row.organisation_id}:{row.membership_id}:"
        f"{row.device_id}:{row.version}:{row.platform}"
    ).encode()


def subscription_data(row: PushSubscription) -> dict[str, str]:
    key = seal_key()
    ciphertext = bytes(row.sealed_subscription)
    try:
        try:
            raw = sealing.unseal(key, associated(row), ciphertext)
        except sealing.SealError:
            if row.platform != "web":
                raise
            raw = sealing.unseal(key, associated_v1(row), ciphertext)
        result = json.loads(raw)
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


def put_subscription(
    *, verified: VerifiedAccessToken, device_id: UUID, body: dict[str, Any], request_id: str
) -> None:
    raw_platform = body.get("platform", "web")
    if not isinstance(raw_platform, str) or raw_platform not in PUSH_PLATFORMS:
        raise RefusalError(422)
    with transaction.atomic():
        initial = read_caller(verified)
    public_key()
    key = seal_key()
    try:
        endpoint = push.subscription(body["endpoint"], body["p256dh"], body["auth"])
    except outbound.FetchError as failure:
        raise RefusalError(503, "service-unavailable", failure.reason) from None
    except ValueError:
        raise RefusalError(422) from None
    material = {"endpoint": endpoint, "p256dh": body["p256dh"], "auth": body["auth"]}
    _store_subscription(
        verified=verified,
        device_id=device_id,
        platform=raw_platform,
        material=material,
        key=key,
        organisation_id=initial.organisation_id,
        request_id=request_id,
    )


@transaction.atomic
def _store_subscription(
    *,
    verified: VerifiedAccessToken,
    device_id: UUID,
    platform: str,
    material: dict[str, str],
    key: bytes,
    organisation_id: UUID,
    request_id: str,
) -> None:
    initial = read_caller(verified, organisation_id)
    # Hold shared erasure advisories and membership fence in canonical advisories -> m -> w order.
    member = for_workspace(
        organisation_id=initial.organisation_id, membership_id=initial.membership_id, lock=False
    )
    if member is None:
        raise RefusalError(403)
    lock_erasure_cutoff_fences(organisation_id=initial.organisation_id, user_id=member.user_id)
    if (
        for_workspace(organisation_id=initial.organisation_id, membership_id=initial.membership_id)
        is None
    ):
        raise RefusalError(403)
    principal = caller(verified, initial.organisation_id)
    if (
        for_workspace(
            organisation_id=principal.organisation_id,
            membership_id=principal.membership_id,
            lock=False,
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
    if row is not None and row.revoked_at is None and row.platform == platform:
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
    row.platform = platform
    row.version, row.revoked_at = uuid4(), None
    row.endpoint_digest = hashlib.sha256(material["endpoint"].encode()).hexdigest()
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
                        "platform",
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
def put_presence(
    *, verified: VerifiedAccessToken, device_id: UUID, body: dict[str, Any], request_id: str
) -> dict[str, Any]:
    del request_id
    platform = body.get("platform")
    ttl_seconds = body.get("ttlSeconds", DEFAULT_PRESENCE_TTL_SECONDS)
    if (
        not isinstance(platform, str)
        or platform not in FOREGROUND_PRESENCE_PLATFORMS
        or type(ttl_seconds) is not int
        or not 1 <= ttl_seconds <= MAX_PRESENCE_TTL_SECONDS
    ):
        raise RefusalError(422)
    initial = read_caller(verified)
    member = for_workspace(
        organisation_id=initial.organisation_id, membership_id=initial.membership_id, lock=False
    )
    if member is None:
        raise RefusalError(403)
    lock_erasure_cutoff_fences(organisation_id=initial.organisation_id, user_id=member.user_id)
    if (
        for_workspace(organisation_id=initial.organisation_id, membership_id=initial.membership_id)
        is None
    ):
        raise RefusalError(403)
    principal = caller(verified, initial.organisation_id)
    if (
        for_workspace(
            organisation_id=principal.organisation_id,
            membership_id=principal.membership_id,
            lock=False,
        )
        is None
    ):
        raise RefusalError(403)
    row = (
        PresenceLease.objects.select_for_update()
        .filter(
            organisation_id=principal.organisation_id,
            membership_id=principal.membership_id,
            device_id=device_id,
        )
        .first()
    )
    now = timezone.now()
    expires_at = now + timedelta(seconds=ttl_seconds)
    try:
        with transaction.atomic():
            if row is None:
                row = PresenceLease(
                    organisation_id=principal.organisation_id,
                    membership_id=principal.membership_id,
                    device_id=device_id,
                    platform=platform,
                    expires_at=expires_at,
                )
                row.save(force_insert=True)
            else:
                PresenceLease.objects.filter(pk=row.pk).update(
                    platform=platform,
                    expires_at=expires_at,
                    updated_at=now,
                )
    except IntegrityError:
        raise RefusalError(409) from None
    return {
        "deviceId": str(device_id),
        "platform": platform,
        "expiresAt": expires_at.astimezone(UTC).isoformat().replace("+00:00", "Z"),
        "ttlSeconds": ttl_seconds,
    }


@transaction.atomic
def delete_presence(*, verified: VerifiedAccessToken, device_id: UUID, request_id: str) -> None:
    del request_id
    initial = read_caller(verified)
    member = for_workspace(
        organisation_id=initial.organisation_id, membership_id=initial.membership_id, lock=False
    )
    if member is None:
        raise RefusalError(403)
    lock_erasure_cutoff_fences(organisation_id=initial.organisation_id, user_id=member.user_id)
    principal = caller(verified, initial.organisation_id)
    PresenceLease.objects.select_for_update().filter(
        organisation_id=principal.organisation_id,
        membership_id=principal.membership_id,
        device_id=device_id,
    ).delete()


def has_active_foreground_presence(
    *, organisation_id: UUID, membership_id: UUID, now: datetime | None = None
) -> bool:
    ref = timezone.now() if now is None else now
    return PresenceLease.objects.filter(
        organisation_id=organisation_id,
        membership_id=membership_id,
        platform__in=FOREGROUND_PRESENCE_PLATFORMS,
        expires_at__gt=ref,
    ).exists()


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


def _visible_ids(
    rows: Sequence[Notification], principal: TenantCaller, verified: VerifiedAccessToken
) -> set[UUID]:
    if not rows:
        return set()
    allowed: set[UUID] = set()
    mention_rows: list[Notification] = []
    document_rows: list[Notification] = []
    reminder_rows: list[Notification] = []
    for row in rows:
        if row.kind == "moderation":
            if row.resource_id == principal.membership_id:
                allowed.add(row.id)
        elif row.kind == "invitation":
            allowed.add(row.id)
        elif row.kind == "mention":
            if row.organisation_id == principal.organisation_id:
                mention_rows.append(row)
        elif row.kind == "document":
            document_rows.append(row)
        elif row.kind == "reminder":
            if row.organisation_id == principal.organisation_id:
                reminder_rows.append(row)

    if mention_rows or reminder_rows:
        from apps.workspaces.channel_access import may_view, resolve_channels
        from apps.workspaces.selectors import (
            is_designated_confidential_channel,
            workspace_id_for,
        )

        workspace_id = workspace_id_for(organisation_id=principal.organisation_id)
        if workspace_id is not None:
            reminders_by_id: dict[UUID, PersonalReminder] = {}
            reminder_channel_ids: set[UUID] = set()
            if reminder_rows:
                for rem in PersonalReminder.objects.filter(
                    id__in={row.resource_id for row in reminder_rows},
                    organisation_id=principal.organisation_id,
                    membership_id=principal.membership_id,
                ).exclude(state__in=("cancelled", "obsolete")):
                    reminders_by_id[rem.id] = rem
                    if rem.channel_id is not None:
                        reminder_channel_ids.add(rem.channel_id)

            needed_channels = {row.resource_id for row in mention_rows} | reminder_channel_ids
            access_by_channel = (
                resolve_channels(workspace_id, needed_channels) if needed_channels else {}
            )
            viewable_channels = {
                channel_id
                for channel_id, access in access_by_channel.items()
                if may_view(
                    access,
                    organisation_id=principal.organisation_id,
                    membership_id=principal.membership_id,
                    authority_revision=principal.authority_revision,
                )
            }
            allowed.update(row.id for row in mention_rows if row.resource_id in viewable_channels)
            for row in reminder_rows:
                reminder = reminders_by_id.get(row.resource_id)
                if reminder is None:
                    continue
                if reminder.channel_id is not None:
                    if (
                        reminder.channel_id in viewable_channels
                        and not is_designated_confidential_channel(
                            workspace_id=workspace_id, channel_id=reminder.channel_id
                        )
                    ):
                        allowed.add(row.id)
                elif reminder.room_id:
                    allowed.add(row.id)

    if document_rows and apps.is_installed("apps.docs"):
        # A missing document-policy adapter fails closed until the docs application is installed.
        try:
            from apps.docs.access import visible_document_ids
        except ImportError:
            visible_docs: set[UUID] = set()
        else:
            visible_docs = visible_document_ids(
                principal,
                {row.resource_id for row in document_rows},
                verified=verified,
            )
        allowed.update(row.id for row in document_rows if row.resource_id in visible_docs)

    return allowed


def visible(row: Notification, principal: TenantCaller, verified: VerifiedAccessToken) -> bool:
    return row.id in _visible_ids((row,), principal, verified)


@transaction.atomic
def inbox(*, verified: VerifiedAccessToken, cursor: str | None, limit: int) -> dict[str, Any]:
    principal = read_caller(verified)
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
    allowed = _visible_ids(selected, principal, verified)
    return {
        "data": [wire(row) for row in selected if row.id in allowed],
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
    if len(selected) != len(ids) or len(_visible_ids(selected, principal, verified)) != len(
        selected
    ):
        raise RefusalError(404)
    rows.filter(read_at__isnull=True).update(read_at=timezone.now(), updated_at=timezone.now())
    audit(principal, "workspace.notification.read", principal.membership_id, request_id)


def record(
    *, organisation_id: UUID, membership_id: UUID, kind: str, resource_id: UUID
) -> Notification:
    """Internal producer. Its caller authorizes the referenced resource in this transaction."""
    if not connection.in_atomic_block:
        raise RuntimeError("notification creation belongs to the producer's transaction")
    if kind not in set(NOTIFICATION_KINDS) or not isinstance(resource_id, UUID):
        raise ValueError("notification kind or resource refused")
    if (
        for_workspace(organisation_id=organisation_id, membership_id=membership_id, lock=False)
        is None
    ):
        raise ValueError("notification recipient refused")
    row = Notification.objects.create(
        organisation_id=organisation_id,
        membership_id=membership_id,
        kind=kind,
        resource_id=resource_id,
    )
    now = timezone.now()
    subscriptions = PushSubscription.objects.filter(
        organisation_id=organisation_id,
        membership_id=membership_id,
        revoked_at__isnull=True,
    )
    if has_active_foreground_presence(
        organisation_id=organisation_id, membership_id=membership_id, now=now
    ):
        subscriptions = subscriptions.exclude(platform__in=MOBILE_PUSH_PLATFORMS)
    PushOutbox.objects.bulk_create(
        [
            PushOutbox(subscription=sub, subscription_version=sub.version, available_at=now)
            for sub in subscriptions
        ]
    )
    return row


@transaction.atomic
def authorize(verified: VerifiedAccessToken, organisation_id: UUID | None = None) -> None:
    read_caller(verified, organisation_id)


def record_moderation(*, organisation_id: UUID, membership_id: UUID) -> None:
    """Explicit producer port, called in the moderation audit writer's transaction."""
    if not connection.in_atomic_block:
        raise RuntimeError("moderation notification belongs to its producer transaction")
    if (
        for_workspace(organisation_id=organisation_id, membership_id=membership_id, lock=False)
        is not None
    ):
        record(
            organisation_id=organisation_id,
            membership_id=membership_id,
            kind="moderation",
            resource_id=membership_id,
        )


def disarm_rehearsal_outbound(
    *,
    now: datetime,
    excluded_organisation_ids: Sequence[UUID] = (),
    excluded_user_ids: Sequence[UUID] = (),
) -> dict[str, int]:
    """Drain pending/in-flight push outbox rows and revoke push subscriptions in rehearsal DB."""
    if not connection.in_atomic_block:
        raise RuntimeError("disarm_rehearsal_outbound requires an enclosing atomic transaction")

    outbox_qs = PushOutbox.objects.filter(state__in=("pending", "in_flight"))
    sub_qs = PushSubscription.objects.filter(revoked_at__isnull=True)
    reminder_qs = PersonalReminder.objects.filter(state__in=("pending", "in_flight", "snoozed"))
    if excluded_organisation_ids:
        outbox_qs = outbox_qs.exclude(subscription__organisation_id__in=excluded_organisation_ids)
        sub_qs = sub_qs.exclude(organisation_id__in=excluded_organisation_ids)
        reminder_qs = reminder_qs.exclude(organisation_id__in=excluded_organisation_ids)
    if excluded_user_ids:
        outbox_qs = outbox_qs.exclude(subscription__membership__user_id__in=excluded_user_ids)
        sub_qs = sub_qs.exclude(membership__user_id__in=excluded_user_ids)
        reminder_qs = reminder_qs.exclude(membership__user_id__in=excluded_user_ids)

    push_outbox_disarmed = outbox_qs.update(
        state="obsolete",
        lease_id=None,
        lease_expires_at=None,
        updated_at=now,
    )
    push_subscriptions_revoked = sub_qs.update(
        revoked_at=now,
        updated_at=now,
    )
    personal_reminders_disarmed = reminder_qs.update(
        state="obsolete",
        lease_id=None,
        lease_expires_at=None,
        updated_at=now,
    )
    return {
        "push_outbox_disarmed": push_outbox_disarmed,
        "push_subscriptions_revoked": push_subscriptions_revoked,
        "personal_reminders_disarmed": personal_reminders_disarmed,
    }


def count_residual_rows_for_organisation(*, organisation_id: UUID) -> int:
    """Count any remaining notification, push subscription, outbox, reminder, or presence rows for an erased org."""
    return (
        Notification.objects.filter(organisation_id=organisation_id).count()
        + PushOutbox.objects.filter(subscription__organisation_id=organisation_id).count()
        + PushSubscription.objects.filter(organisation_id=organisation_id).count()
        + PresenceLease.objects.filter(organisation_id=organisation_id).count()
        + PersonalReminder.objects.filter(organisation_id=organisation_id).count()
    )


def count_residual_rows_for_user(*, user_id: UUID) -> int:
    """Count any remaining notification, push subscription, outbox, reminder, or presence rows for an erased user."""
    return (
        Notification.objects.filter(membership__user_id=user_id).count()
        + PushOutbox.objects.filter(subscription__membership__user_id=user_id).count()
        + PushSubscription.objects.filter(membership__user_id=user_id).count()
        + PresenceLease.objects.filter(membership__user_id=user_id).count()
        + PersonalReminder.objects.filter(membership__user_id=user_id).count()
    )


def purge_rows_for_user(*, user_id: UUID) -> int:
    """Delete notification, push outbox, push subscription, reminder, and presence rows for `user_id`."""
    c_outbox, _ = PushOutbox.objects.filter(subscription__membership__user_id=user_id).delete()
    c_sub, _ = PushSubscription.objects.filter(membership__user_id=user_id).delete()
    c_rem, _ = PersonalReminder.objects.filter(membership__user_id=user_id).delete()
    c_notif, _ = Notification.objects.filter(membership__user_id=user_id).delete()
    c_pres, _ = PresenceLease.objects.filter(membership__user_id=user_id).delete()
    return int(c_outbox + c_sub + c_rem + c_notif + c_pres)


def drain_snapshot_in_flight_leases(*, now: datetime) -> int:
    """Drain frozen `state='in_flight'` push outbox leases from a point-in-time backup snapshot."""
    if not connection.in_atomic_block:
        raise RuntimeError(
            "drain_snapshot_in_flight_leases requires an enclosing atomic transaction"
        )
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT DISTINCT s.organisation_id FROM notifications_pushoutbox q "
            "JOIN notifications_pushsubscription s ON s.id = q.subscription_id "
            "JOIN orgs_privacyerasure pe ON pe.organisation_reference = s.organisation_id "
            "WHERE q.state = 'in_flight' "
            "ORDER BY s.organisation_id"
        )
        fenced_orgs = [row[0] for row in cursor.fetchall()]

        cursor.execute(
            "SELECT DISTINCT m.user_id FROM notifications_pushoutbox q "
            "JOIN notifications_pushsubscription s ON s.id = q.subscription_id "
            "JOIN orgs_membership m ON m.id = s.membership_id "
            "JOIN orgs_accounterasure ae ON ae.user_reference = m.user_id "
            "WHERE q.state = 'in_flight' "
            "ORDER BY m.user_id"
        )
        fenced_users = [row[0] for row in cursor.fetchall()]

        for org_id in fenced_orgs:
            cursor.execute(
                "INSERT INTO public.retention_worker_context "
                "VALUES (pg_backend_pid(), txid_current(), 'erase', 'orgs_organisation', %s, '{}')",
                [org_id],
            )
        for uid in fenced_users:
            cursor.execute(
                "INSERT INTO public.retention_worker_context "
                "VALUES (pg_backend_pid(), txid_current(), 'account', 'identity_user', %s, '{}')",
                [uid],
            )
        try:
            cursor.execute(
                "UPDATE notifications_pushoutbox "
                "SET state = 'obsolete', lease_id = NULL, lease_expires_at = NULL, updated_at = %s "
                "WHERE state = 'in_flight'",
                [now],
            )
            drained = int(cursor.rowcount or 0)
            cursor.execute(
                "UPDATE notifications_personalreminder "
                "SET state = 'obsolete', lease_id = NULL, lease_expires_at = NULL, updated_at = %s "
                "WHERE state = 'in_flight'",
                [now],
            )
            drained += int(cursor.rowcount or 0)
        finally:
            for uid in fenced_users:
                cursor.execute(
                    "DELETE FROM public.retention_worker_context "
                    "WHERE backend = pg_backend_pid() AND transaction = txid_current() "
                    "  AND purpose = 'account' AND source_table = 'identity_user' AND source_id = %s",
                    [uid],
                )
            for org_id in fenced_orgs:
                cursor.execute(
                    "DELETE FROM public.retention_worker_context "
                    "WHERE backend = pg_backend_pid() AND transaction = txid_current() "
                    "  AND purpose = 'erase' AND source_table = 'orgs_organisation' AND source_id = %s",
                    [org_id],
                )
    return drained


@dataclass(frozen=True, slots=True)
class PersonalReminderRecord:
    id: UUID
    organisation_id: UUID
    membership_id: UUID
    channel_id: UUID | None
    room_id: str
    target_event_id: str
    note: str
    remind_at: datetime
    state: str
    notification_id: UUID | None
    created_at: datetime
    updated_at: datetime


def _reminder_record(row: PersonalReminder) -> PersonalReminderRecord:
    return PersonalReminderRecord(
        id=row.id,
        organisation_id=row.organisation_id,
        membership_id=row.membership_id,
        channel_id=row.channel_id,
        room_id=row.room_id,
        target_event_id=row.target_event_id,
        note=row.note,
        remind_at=row.remind_at,
        state=row.state,
        notification_id=row.notification_id,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def list_member_reminders(
    *,
    organisation_id: UUID,
    membership_id: UUID,
    include_completed: bool = False,
    limit: int = 200,
) -> tuple[PersonalReminderRecord, ...]:
    qs = PersonalReminder.objects.filter(
        organisation_id=organisation_id,
        membership_id=membership_id,
    )
    if include_completed:
        qs = qs.exclude(state__in=("cancelled", "obsolete"))
    else:
        qs = qs.filter(state__in=("pending", "in_flight", "fired", "snoozed"))
    return tuple(_reminder_record(row) for row in qs.order_by("remind_at", "id")[:limit])


def count_active_member_reminders(*, organisation_id: UUID, membership_id: UUID) -> int:
    return PersonalReminder.objects.filter(
        organisation_id=organisation_id,
        membership_id=membership_id,
        state__in=("pending", "in_flight", "fired", "snoozed"),
    ).count()


def create_member_reminder(
    *,
    organisation_id: UUID,
    membership_id: UUID,
    channel_id: UUID | None,
    room_id: str,
    target_event_id: str,
    note: str,
    remind_at: datetime,
) -> PersonalReminderRecord:
    row = PersonalReminder.objects.create(
        organisation_id=organisation_id,
        membership_id=membership_id,
        channel_id=channel_id,
        room_id=room_id,
        target_event_id=target_event_id,
        note=note,
        remind_at=remind_at,
        state=PersonalReminder.State.PENDING,
    )
    return _reminder_record(row)


def lock_member_reminder(
    *,
    reminder_id: UUID,
    organisation_id: UUID,
    membership_id: UUID,
) -> PersonalReminderRecord | None:
    row = (
        PersonalReminder.objects.select_for_update()
        .filter(
            id=reminder_id,
            organisation_id=organisation_id,
            membership_id=membership_id,
        )
        .first()
    )
    return None if row is None else _reminder_record(row)


def update_member_reminder(
    *,
    reminder_id: UUID,
    organisation_id: UUID,
    membership_id: UUID,
    note: str | None = None,
    remind_at: datetime | None = None,
    state: str | None = None,
) -> PersonalReminderRecord:
    row = PersonalReminder.objects.get(
        id=reminder_id,
        organisation_id=organisation_id,
        membership_id=membership_id,
    )
    update_fields = ["updated_at"]
    if note is not None:
        row.note = note
        update_fields.append("note")
    if remind_at is not None:
        row.remind_at = remind_at
        update_fields.append("remind_at")
    if state is not None:
        row.state = state
        update_fields.append("state")
    row.save(update_fields=update_fields)
    return _reminder_record(row)
