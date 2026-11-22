"""Fenced at-least-once webhook work; unknown network outcomes require reconciliation."""

from __future__ import annotations

import hashlib
import inspect
import json
import time
from dataclasses import dataclass
from datetime import timedelta
from typing import Protocol
from uuid import UUID, uuid4

from django.db import transaction
from django.utils import timezone

from apps.identity import selectors as identities
from apps.media import outbound
from apps.orgs import selectors as organisations
from apps.workspaces import selectors as workspaces

from .models import Delivery, DeliveryAttempt, Installation, WorkspaceCutoff
from .wire import ExtensionRefusedError, signed_delivery


def _accepts_scope_key(fn: object) -> bool:
    try:
        params = inspect.signature(fn).parameters.values()  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return False
    return any(
        param.kind == inspect.Parameter.VAR_KEYWORD or param.name == "scope_key" for param in params
    )


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


def eligible(row: Installation, *, organisation_id: UUID | None = None) -> bool:
    org_id = (
        workspaces.workspace_organisation(workspace_id=row.workspace_id)
        if organisation_id is None
        else organisation_id
    )
    if (
        row.revoked_at is not None
        or WorkspaceCutoff.objects.filter(organisation_id=org_id).exists()
        or not organisations.active_organisation(organisation_id=org_id)
    ):
        return False
    user_id = organisations.installation_admin_user(
        membership_id=row.creator_id, organisation_id=org_id
    )
    return user_id is not None and identities.delivery_identity_exists(
        user_id=user_id, organisation_id=org_id
    )


def send(endpoint: str, signed, *, scope_key: str | None = None) -> tuple[str, int | None]:
    connection = response = None
    try:
        destination = outbound.target(endpoint, https_only=True)
        connection, response = outbound.request(
            destination,
            method="POST",
            body=signed.body,
            headers=signed.headers,
            deadline=time.monotonic() + 5,
            pool="webhook",
            scope_key=scope_key,
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
    except outbound.PreSendFetchError:
        # DNS lookup failure, resolver-busy, TCP ECONNREFUSED and TLS handshake failure all
        # occur before a single HTTP byte is transmitted, so retry safely without reconciliation.
        return "retry", None
    except (outbound.FetchError, OSError, ValueError):
        return "uncertain", None
    finally:
        if response is not None:
            response.close()
        if connection is not None:
            connection.close()


def _record_delivery_outcome(row: Delivery, lease: UUID, result: str, status: int | None) -> None:
    now = timezone.now()
    DeliveryAttempt.objects.filter(delivery=row, lease_id=lease, outcome="started").update(
        outcome=result, response_status=status, updated_at=now
    )
    row.outcome, row.response_status = result, status
    row.state = {
        "delivered": "delivered",
        "obsolete": "obsolete",
        "refused": "dead_letter",
        "uncertain": "needs_reconciliation",
        "retry": "pending" if row.attempts < 8 else "dead_letter",
    }[result]
    row.available_at = now + timedelta(seconds=min(3600, 30 * 2**row.attempts))
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


def dispatch_claim(job: Claim, secrets: Secrets | None) -> None:
    # Step 1: Verify authority, revocation and privacy cutoffs in canonical
    # org_advisory -> account_advisory -> m -> i -> u -> o -> w -> installation -> delivery
    # lock order, and release ALL database locks BEFORE performing external HTTP I/O.
    prepared: tuple[str, object, str] | None = None
    with transaction.atomic():
        meta = (
            Installation.objects.filter(id=job.installation_id, workspace_id=job.workspace_id)
            .values_list("workspace__organisation_id", "creator_id", "creator__user_id")
            .first()
        )
        if meta is None:
            row = (
                Delivery.objects.select_for_update()
                .filter(id=job.delivery_id, state="in_flight", lease_id=job.lease)
                .first()
            )
            if row is not None:
                _record_delivery_outcome(row, job.lease, "obsolete", None)
            return

        organisation_id, creator_id, creator_user_id = meta
        organisations.lock_erasure_cutoff_fences(
            organisation_id=organisation_id, user_id=creator_user_id
        )
        member_user_id = organisations.lock_membership_fence_if_present(membership_id=creator_id)
        if member_user_id is not None:
            identities.lock_delivery_identities(
                user_id=member_user_id, organisation_id=organisation_id
            )
            user_exists = identities.lock_user_fence_if_present(user_id=member_user_id)
        else:
            user_exists = False
        org_exists = organisations.lock_organisation(organisation_id=organisation_id)
        ws_exists = (
            workspaces.lock_workspace_if_present(workspace_id=job.workspace_id)
            if org_exists
            else False
        )
        installation = (
            Installation.objects.select_for_update().filter(id=job.installation_id).first()
        )
        row = (
            Delivery.objects.select_for_update()
            .filter(id=job.delivery_id, state="in_flight", lease_id=job.lease)
            .first()
        )
        if row is None:
            return

        now = timezone.now()
        early_result: str | None = None
        if (
            not (user_exists and org_exists and ws_exists)
            or installation is None
            or member_user_id is None
        ):
            early_result = "obsolete"
        elif row.expires_at <= now or row.purged_at is not None:
            early_result = "obsolete"
        elif row.lease_expires_at is None or row.lease_expires_at <= now:
            early_result = "uncertain"
        elif row.installation_version != installation.version or not eligible(
            installation, organisation_id=organisation_id
        ):
            early_result = "obsolete"
        elif hashlib.sha256(bytes(row.event)).hexdigest() != row.event_sha256:
            early_result = "refused"
        elif secrets is None:
            # Known no-send: retain work until a provider is explicitly injected.
            early_result = "retry"
        else:
            try:
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
                    organisation_id=organisation_id,
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
                early_result = "retry"
            else:
                if json.loads(signed.body)["type"] not in installation.events:
                    early_result = "obsolete"
                else:
                    prepared = (installation.endpoint, signed, str(organisation_id))

        if early_result is not None:
            _record_delivery_outcome(row, job.lease, early_result, None)
            return

    if prepared is None:
        return
    endpoint, signed_payload, scope_key = prepared

    # Step 2: Execute external DNS/TLS/HTTP outside any database transaction or tenant lock.
    # Inspect `send`'s signature BEFORE invoking it so a post-transmission `TypeError` never
    # triggers a duplicate delivery attempt.
    accepts_scope = _accepts_scope_key(send)
    try:
        if accepts_scope:
            result, status = send(endpoint, signed_payload, scope_key=scope_key)
        else:
            result, status = send(endpoint, signed_payload)
    except Exception:
        # Once transport begins, an unexpected failure cannot prove the receiver did not apply it.
        result, status = "uncertain", None

    # Step 3: Short transaction recording delivery status and backoff if lease is still held.
    with transaction.atomic():
        row = (
            Delivery.objects.select_for_update()
            .filter(id=job.delivery_id, state="in_flight", lease_id=job.lease)
            .first()
        )
        if row is None:
            return
        _record_delivery_outcome(row, job.lease, result, status)


def dispatch_one(secrets: Secrets | None = None) -> bool:
    if secrets is None:
        raise ExtensionRefusedError("extension_secret_provider_unconfigured", 503)
    job = claim()
    if job is None:
        return False
    dispatch_claim(job, secrets)
    return True
