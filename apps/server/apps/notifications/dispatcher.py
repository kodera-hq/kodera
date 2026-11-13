"""A leased outbox whose only provider effect is a body-free device wakeup."""

from dataclasses import dataclass
from datetime import timedelta
from uuid import UUID, uuid4

from cryptography.hazmat.primitives.asymmetric import ec
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from apps.media import outbound
from apps.media.context import RefusalError

from . import push
from .models import PushOutbox, PushSubscription
from .services import public_key, subscription_data


@dataclass(frozen=True)
class Claim:
    id: UUID
    lease: UUID
    subscription_id: UUID
    version: UUID


@transaction.atomic
def claim() -> Claim | None:
    now = timezone.now()
    PushOutbox.objects.filter(
        state="in_flight", lease_expires_at__lte=now, attempts__gte=10
    ).update(
        state="failed",
        lease_id=None,
        lease_expires_at=None,
        updated_at=now,
    )
    row = (
        PushOutbox.objects.select_for_update(skip_locked=True)
        .filter(
            Q(state="pending", available_at__lte=now)
            | Q(state="in_flight", lease_expires_at__lte=now),
            attempts__lt=10,
        )
        .order_by("available_at", "id")
        .first()
    )
    if row is None:
        return None
    row.state, row.lease_id = "in_flight", uuid4()
    row.lease_expires_at = now + timedelta(seconds=30)
    row.attempts += 1
    row.save(update_fields=["state", "lease_id", "lease_expires_at", "attempts", "updated_at"])
    return Claim(row.id, row.lease_id, row.subscription_id, row.subscription_version)


def eligible(subscription: PushSubscription) -> bool:
    return (
        PushSubscription.objects.filter(
            pk=subscription.id,
            version=subscription.version,
            revoked_at__isnull=True,
            membership__organisation_id=subscription.organisation_id,
            membership__state="active",
            membership__accepted_at__isnull=False,
            membership__deleted_at__isnull=True,
            membership__user__enabled=True,
            membership__user__deleted_at__isnull=True,
            membership__user__identity__organisation_id=subscription.organisation_id,
            membership__user__identity__enabled=True,
            membership__user__identity__deleted_at__isnull=True,
            organisation__state="active",
            organisation__deleted_at__isnull=True,
            organisation__workspace__id__isnull=False,
        )
        .exclude(
            membership__workspacememberrestriction__banned=True,
        )
        .exclude(
            membership__workspacememberrestriction__kicked=True,
        )
        .exists()
    )


@transaction.atomic
def finish(job: Claim, result: push.Result) -> None:
    row = (
        PushOutbox.objects.select_for_update()
        .filter(pk=job.id, state="in_flight", lease_id=job.lease)
        .first()
    )
    if row is None:
        return  # A reclaimed lease owns the result now.
    now = timezone.now()
    current = PushSubscription.objects.filter(
        pk=job.subscription_id, version=job.version, revoked_at__isnull=True
    )
    if not current.exists() or result.outcome == "obsolete":
        row.state = "obsolete"
    elif result.outcome == "dead":
        # A replacement subscription cannot be revoked by this old request's response.
        current.update(revoked_at=now, updated_at=now)
        row.state = "obsolete"
    elif result.outcome == "delivered":
        row.state = "delivered"
    elif result.outcome == "retry" and row.attempts < 10:
        row.state = "pending"
        row.available_at = now + timedelta(seconds=max(1, min(3600, result.retry_after)))
    else:
        row.state = "failed"
    row.lease_id = row.lease_expires_at = None
    row.save(update_fields=["state", "available_at", "lease_id", "lease_expires_at", "updated_at"])


def dispatch_claim(job: Claim, private_key: ec.EllipticCurvePrivateKey, subject: str) -> None:
    subscription = PushSubscription.objects.filter(
        pk=job.subscription_id, version=job.version, revoked_at__isnull=True
    ).first()
    result = push.Result("obsolete")
    try:
        if subscription is not None and eligible(subscription):
            if push.public_key(private_key) != public_key():
                raise RefusalError(503, "service-unavailable")
            data = subscription_data(subscription)
            result = push.send(data["endpoint"], private_key, subject)
    except outbound.BlockedTargetError:
        result = push.Result("refused")
    except (outbound.FetchError, OSError, RefusalError, ValueError):
        result = push.Result("retry", 60)
    finish(job, result)


def dispatch_one(private_key: ec.EllipticCurvePrivateKey, subject: str) -> bool:
    job = claim()
    if job is None:
        return False
    dispatch_claim(job, private_key, subject)
    return True
