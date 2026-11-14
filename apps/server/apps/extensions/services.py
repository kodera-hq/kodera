"""Current owner/admin installation authority and durable scope-bound queueing."""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from django.db import transaction
from django.utils import timezone

from apps.audit.services import check_extension_event, record_extension_event
from apps.docs import services as documents
from apps.identity.selectors import lock_delivery_identity
from apps.media import outbound
from apps.orgs.selectors import lock_membership_user, lock_organisation
from core.db.ids import new_uuid7

from .models import Delivery, Installation, WorkspaceCutoff
from .wire import EVENTS, MAX_GRACE_SECONDS, ExtensionRefusedError, event_payload


def admin(verified, organisation_id):
    if not lock_organisation(organisation_id=organisation_id):
        raise ExtensionRefusedError("extension_workspace_absent", 404)
    if WorkspaceCutoff.objects.filter(organisation_id=organisation_id).exists():
        raise ExtensionRefusedError("extension_workspace_cut_off", 410)
    workspace_id, principal = documents.context(verified, organisation_id)
    lock_membership_user(membership_id=principal.membership_id)
    lock_delivery_identity(identity_id=principal.identity_id)
    # A current-role read after the actor locks sees a revocation that committed first.
    workspace_id, principal = documents.context(verified, organisation_id)
    if principal.role not in {"org_owner", "org_admin"}:
        raise ExtensionRefusedError("extension_owner_or_admin_required", 403)
    return workspace_id, principal


def audit(action, principal, organisation_id, target_id, metadata):
    """The registered action and its closed shape are refused before the actor is read."""
    check_extension_event(action=action, metadata=metadata)
    record_extension_event(
        action=action,
        identity_id=principal.identity_id,
        organisation_id=organisation_id,
        target_id=target_id,
        metadata=metadata,
    )


def scoped(workspace_id: UUID, installation_id: UUID) -> Installation:
    row = (
        Installation.objects.select_for_update()
        .filter(id=installation_id, workspace_id=workspace_id, revoked_at__isnull=True)
        .first()
    )
    if row is None:
        raise ExtensionRefusedError("extension_installation_absent", 404)
    return row


@transaction.atomic
def install(
    *, verified, organisation_id: UUID, name: str, endpoint: str, events: list[str]
) -> Installation:
    workspace_id, principal = admin(verified, organisation_id)
    if (
        not isinstance(events, list)
        or not events
        or any(not isinstance(value, str) or value not in EVENTS for value in events)
        or len(set(events)) != len(events)
    ):
        raise ExtensionRefusedError("extension_events_invalid")
    row = Installation.objects.create(
        workspace_id=workspace_id,
        creator_id=principal.membership_id,
        name=documents.title(name),
        endpoint=outbound.target(endpoint, https_only=True).url,
        events=sorted(events),
    )
    audit("installed", principal, organisation_id, row.id, {"generation": str(row.generation)})
    return row


@transaction.atomic
def rotate(
    *, verified, organisation_id: UUID, installation_id: UUID, grace_expires_at: datetime
) -> Installation:
    workspace_id, principal = admin(verified, organisation_id)
    row = scoped(workspace_id, installation_id)
    now = timezone.now()
    if grace_expires_at.tzinfo is None or not now < grace_expires_at <= now + timedelta(
        seconds=MAX_GRACE_SECONDS
    ):
        raise ExtensionRefusedError("extension_rotation_grace_invalid")
    if row.grace_expires_at is not None and row.grace_expires_at > now:
        raise ExtensionRefusedError("extension_rotation_already_in_grace", 409)
    row.previous_generation, row.generation, row.grace_expires_at = (
        row.generation,
        new_uuid7(),
        grace_expires_at,
    )
    row.save(update_fields=["previous_generation", "generation", "grace_expires_at", "updated_at"])
    audit(
        "rotated",
        principal,
        organisation_id,
        row.id,
        {
            "generation": str(row.generation),
            "previous_generation": str(row.previous_generation),
            "grace_expires_at": grace_expires_at.isoformat(),
        },
    )
    return row


@transaction.atomic
def revoke(*, verified, organisation_id: UUID, installation_id: UUID) -> None:
    workspace_id, principal = admin(verified, organisation_id)
    row = scoped(workspace_id, installation_id)
    row.revoked_at, row.version = timezone.now(), new_uuid7()
    row.save(update_fields=["revoked_at", "version", "updated_at"])
    Delivery.objects.filter(installation=row, state="pending").update(
        state="obsolete", updated_at=timezone.now()
    )
    audit("revoked", principal, organisation_id, row.id, {})


@transaction.atomic
def enqueue(
    *,
    verified,
    organisation_id: UUID,
    installation_id: UUID,
    event_key: str,
    event_type: str,
    data: dict[str, Any],
) -> Delivery:
    workspace_id, principal = admin(verified, organisation_id)
    row = scoped(workspace_id, installation_id)
    if event_type not in row.events:
        raise ExtensionRefusedError("extension_event_not_granted", 403)
    if (
        not isinstance(event_key, str)
        or not 1 <= len(event_key) <= 128
        or not event_key.isascii()
        or not event_key.isprintable()
    ):
        raise ExtensionRefusedError("extension_event_key_invalid")
    event_key = hashlib.sha256(event_key.encode()).hexdigest()
    raw = event_payload(event_type, data)
    digest = hashlib.sha256(raw).hexdigest()
    delivery, created = Delivery.objects.get_or_create(
        installation=row,
        event_key=event_key,
        defaults={
            "installation_version": row.version,
            "event": raw,
            "event_sha256": digest,
            "available_at": timezone.now(),
        },
    )
    if (
        delivery.event_sha256 != digest
        or (delivery.purged_at is None and bytes(delivery.event) != raw)
        or delivery.installation_version != row.version
    ):
        raise ExtensionRefusedError("extension_event_key_reused", 409)
    if created:
        audit(
            "delivery_queued",
            principal,
            organisation_id,
            row.id,
            {"delivery_id": str(delivery.id), "event_type": event_type},
        )
    return delivery


@transaction.atomic
def inspect(*, verified, organisation_id: UUID, installation_id: UUID) -> list[dict[str, Any]]:
    workspace_id, _ = admin(verified, organisation_id)
    row = Installation.objects.filter(id=installation_id, workspace_id=workspace_id).first()
    if row is None:
        raise ExtensionRefusedError("extension_installation_absent", 404)
    return [
        {
            "id": str(job.id),
            "state": job.state,
            "attempts": job.attempts,
            "outcome": job.outcome,
            "response_status": job.response_status,
            "event_sha256": job.event_sha256,
        }
        for job in Delivery.objects.filter(installation=row).order_by("-created_at", "-id")[:100]
    ]


@transaction.atomic
def reconcile(
    *,
    verified,
    organisation_id: UUID,
    installation_id: UUID,
    delivery_id: UUID,
    observed: str,
    evidence_ref: str,
):
    """Current owner/admin attests an observed outcome before releasing an ambiguous attempt."""
    from .models import DeliveryAttempt, DeliveryDecision

    workspace_id, principal = admin(verified, organisation_id)
    installation = (
        Installation.objects.select_for_update()
        .filter(id=installation_id, workspace_id=workspace_id)
        .first()
    )
    if installation is None:
        raise ExtensionRefusedError("extension_installation_absent", 404)
    try:
        if not evidence_ref.startswith(
            "urn:kodera:evidence:"
        ) or evidence_ref != "urn:kodera:evidence:" + str(
            UUID(evidence_ref.removeprefix("urn:kodera:evidence:"))
        ):
            raise ValueError
    except (ValueError, TypeError, AttributeError):
        raise ExtensionRefusedError("extension_observation_evidence_required") from None
    if observed not in {"applied", "not_applied", "abandon"}:
        raise ExtensionRefusedError("extension_observed_outcome_invalid")
    row = (
        Delivery.objects.select_for_update()
        .filter(id=delivery_id, installation=installation)
        .first()
    )
    if row is None:
        raise ExtensionRefusedError("extension_delivery_absent", 404)
    prior = DeliveryDecision.objects.filter(delivery=row, attempt__number=row.attempts).first()
    if prior is not None:
        if (prior.observed, prior.evidence_ref, prior.decided_by_id) != (
            observed,
            evidence_ref,
            principal.membership_id,
        ):
            raise ExtensionRefusedError("extension_decision_reuse", 409)
        return prior
    if row.state != "needs_reconciliation":
        raise ExtensionRefusedError("extension_reconciliation_not_required", 409)
    attempt = (
        DeliveryAttempt.objects.select_for_update()
        .filter(delivery=row, number=row.attempts, outcome="uncertain")
        .first()
    )
    if attempt is None:
        raise ExtensionRefusedError("extension_uncertain_attempt_missing", 503)
    decision = DeliveryDecision.objects.create(
        delivery=row,
        attempt=attempt,
        decided_by_id=principal.membership_id,
        observed=observed,
        evidence_ref=evidence_ref,
    )
    current = (
        installation.revoked_at is None
        and row.installation_version == installation.version
        and row.expires_at > timezone.now()
        and row.purged_at is None
    )
    row.state = (
        "delivered"
        if observed == "applied"
        else "pending"
        if observed == "not_applied" and current and row.attempts < 8
        else "dead_letter"
        if observed == "not_applied" and current
        else "obsolete"
    )
    row.outcome = "observed_" + observed
    row.available_at = timezone.now()
    row.save(update_fields=["state", "outcome", "available_at", "updated_at"])
    audit(
        "delivery_reconciled",
        principal,
        organisation_id,
        installation.id,
        {
            "delivery_id": str(row.id),
            "decision_id": str(decision.id),
            "observed": observed,
            "evidence_ref": evidence_ref,
            "evidence_kind": "owner_admin_attestation",
        },
    )
    return decision
