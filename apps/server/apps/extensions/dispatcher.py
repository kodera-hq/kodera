"""Fenced at-least-once webhook work; unknown network outcomes require reconciliation."""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass
from datetime import timedelta
from typing import Protocol
from uuid import UUID, uuid4

from django.db import transaction
from django.utils import timezone

from apps.identity.models import Identity
from apps.media import outbound
from apps.orgs.models import Membership, Organisation
from apps.workspaces.models import Workspace

from .models import Delivery, DeliveryAttempt, Installation, WorkspaceCutoff
from .wire import ExtensionRefusedError, signed_delivery


class Secrets(Protocol):
    def get(self, *, installation_id: UUID, generation: UUID) -> str: ...


@dataclass(frozen=True)
class Claim:
    delivery_id: UUID
    lease: UUID
    installation_id: UUID
    workspace_id: UUID


@transaction.atomic
def claim() -> Claim | None:
    now = timezone.now()
    # A crashed sender may have transmitted. Do not blindly duplicate that ambiguous attempt.
    expired = list(
        Delivery.objects.select_for_update(skip_locked=True).filter(
            state="in_flight", lease_expires_at__lte=now
        )[:100]
    )
    for expired_row in expired:
        if expired_row.lease_id is None:
            raise ExtensionRefusedError("extension_lease_integrity", 503)
        DeliveryAttempt.objects.filter(
            delivery=expired_row, lease_id=expired_row.lease_id, outcome="started"
        ).update(outcome="uncertain", updated_at=now)
        (
            expired_row.state,
            expired_row.outcome,
            expired_row.lease_id,
            expired_row.lease_expires_at,
        ) = (
            "needs_reconciliation",
            "lease_expired",
            None,
            None,
        )
        expired_row.save(
            update_fields=["state", "outcome", "lease_id", "lease_expires_at", "updated_at"]
        )
    row = (
        Delivery.objects.select_for_update(skip_locked=True)
        .filter(
            state="pending",
            available_at__lte=now,
            attempts__lt=8,
            expires_at__gt=now,
            purged_at__isnull=True,
        )
        .order_by("available_at", "id")
        .first()
    )
    if row is None:
        return None
    row.state, row.lease_id, row.lease_expires_at = (
        "in_flight",
        uuid4(),
        now + timedelta(seconds=30),
    )
    row.attempts += 1
    row.save(update_fields=["state", "lease_id", "lease_expires_at", "attempts", "updated_at"])
    DeliveryAttempt.objects.create(delivery=row, number=row.attempts, lease_id=row.lease_id)
    return Claim(row.id, row.lease_id, row.installation_id, row.installation.workspace_id)


def eligible(row: Installation) -> bool:
    return (
        row.revoked_at is None
        and not WorkspaceCutoff.objects.filter(
            organisation_id=row.workspace.organisation_id
        ).exists()
        and Organisation.objects.filter(
            id=row.workspace.organisation_id, state="active", deleted_at__isnull=True
        ).exists()
        and Membership.objects.filter(
            id=row.creator_id,
            organisation_id=row.workspace.organisation_id,
            state="active",
            role__in=("org_owner", "org_admin"),
            accepted_at__isnull=False,
            deleted_at__isnull=True,
            user__enabled=True,
            user__deleted_at__isnull=True,
        ).exists()
        and Identity.objects.filter(
            user_id=row.creator.user_id,
            organisation_id=row.workspace.organisation_id,
            enabled=True,
            deleted_at__isnull=True,
        ).exists()
    )


def send(endpoint: str, signed) -> tuple[str, int | None]:
    connection = response = None
    try:
        destination = outbound.target(endpoint, https_only=True)
        connection, response = outbound.request(
            destination,
            method="POST",
            body=signed.body,
            headers=signed.headers,
            deadline=time.monotonic() + 5,
        )
        status = response.status
        if len(response.read(32769)) > 32768:
            return "uncertain", status
        if 200 <= status < 300:
            return "delivered", status
        if status in {408, 504}:
            return "uncertain", status
        if status == 429 or 500 <= status <= 599:
            return "retry", status
        return "refused", status  # Redirects never follow; headers never reach a second host.
    except outbound.BlockedTargetError:
        return "refused", None
    except (outbound.FetchError, OSError, ValueError):
        return "uncertain", None
    finally:
        if response is not None:
            response.close()
        if connection is not None:
            connection.close()


def dispatch_claim(job: Claim, secrets: Secrets | None) -> None:
    # Installation revocation and all workspace writers take this same first lock. The bounded
    # request is fenced by it: a revocation committed before this transaction prevents sending.
    with transaction.atomic():
        organisation_id = Workspace.objects.values_list("organisation_id", flat=True).get(
            id=job.workspace_id
        )
        Organisation.objects.select_for_update().get(id=organisation_id)
        Workspace.objects.select_for_update().get(id=job.workspace_id)
        installation = Installation.objects.select_for_update().get(id=job.installation_id)
        member = (
            Membership.objects.select_for_update()
            .select_related("user")
            .get(id=installation.creator_id)
        )
        list(
            Identity.objects.select_for_update().filter(
                user_id=member.user_id, organisation_id=organisation_id
            )
        )
        row = (
            Delivery.objects.select_for_update()
            .filter(id=job.delivery_id, state="in_flight", lease_id=job.lease)
            .first()
        )
        if row is None:
            return
        result, status = "obsolete", None
        if row.expires_at <= timezone.now() or row.purged_at is not None:
            result = "obsolete"
        elif row.lease_expires_at is None or row.lease_expires_at <= timezone.now():
            result = "uncertain"
        elif row.installation_version == installation.version and eligible(installation):
            if hashlib.sha256(bytes(row.event)).hexdigest() != row.event_sha256:
                result = "refused"
            elif secrets is None:
                # Known no-send: retain work until a provider is explicitly injected.
                result = "retry"
            else:
                try:
                    now = timezone.now()
                    previous = None
                    if (
                        installation.previous_generation is not None
                        and installation.grace_expires_at is not None
                        and installation.grace_expires_at > now
                    ):
                        previous = secrets.get(
                            installation_id=installation.id,
                            generation=installation.previous_generation,
                        )
                    signed = signed_delivery(
                        organisation_id=installation.workspace.organisation_id,
                        installation_id=installation.id,
                        delivery_id=row.id,
                        generation=installation.generation,
                        event=bytes(row.event),
                        secret=secrets.get(
                            installation_id=installation.id, generation=installation.generation
                        ),
                        now=now,
                        previous_generation=installation.previous_generation,
                        previous_secret=previous,
                        grace_expires_at=installation.grace_expires_at,
                    )
                except Exception:
                    # Key-provider failures expose no secret/exception body. No request started.
                    result = "retry"
                else:
                    if json.loads(signed.body)["type"] not in installation.events:
                        result = "obsolete"
                    else:
                        try:
                            result, status = send(installation.endpoint, signed)
                        except Exception:
                            # Once transport begins, even an unexpected cleanup failure cannot
                            # establish that the receiver did not apply the signed event.
                            result, status = "uncertain", None
        DeliveryAttempt.objects.filter(delivery=row, lease_id=job.lease, outcome="started").update(
            outcome=result, response_status=status, updated_at=timezone.now()
        )
        row.outcome, row.response_status = result, status
        row.state = {
            "delivered": "delivered",
            "obsolete": "obsolete",
            "refused": "dead_letter",
            "uncertain": "needs_reconciliation",
            "retry": "pending" if row.attempts < 8 else "dead_letter",
        }[result]
        row.available_at = timezone.now() + timedelta(seconds=min(3600, 30 * 2**row.attempts))
        row.lease_id = row.lease_expires_at = None
        row.save(
            update_fields=[
                "state",
                "outcome",
                "response_status",
                "available_at",
                "lease_id",
                "lease_expires_at",
                "updated_at",
            ]
        )


def dispatch_one(secrets: Secrets | None = None) -> bool:
    if secrets is None:
        raise ExtensionRefusedError("extension_secret_provider_unconfigured", 503)
    job = claim()
    if job is None:
        return False
    dispatch_claim(job, secrets)
    return True
