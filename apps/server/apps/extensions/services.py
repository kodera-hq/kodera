"""Current owner/admin installation authority and durable scope-bound queueing."""

from __future__ import annotations

import hashlib
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from http.client import HTTPException
from typing import Any
from uuid import UUID

from django.db import transaction
from django.utils import timezone

from apps.audit.services import record_extension_event
from apps.docs import services as documents
from apps.identity.selectors import lock_delivery_identity, lock_user_fence
from apps.media import outbound, services as media_services
from apps.media.context import RefusalError as MediaRefusalError
from apps.orgs.selectors import (
    lock_erasure_cutoff_fences,
    lock_membership_fence,
    lock_organisation,
    membership_user_id,
    organisation_exists,
)
from core.db.ids import new_uuid7

from .import_parsers import MAX_ARCHIVE
from .models import Delivery, Installation, WorkspaceCutoff
from .wire import (
    EVENTS,
    MAX_GRACE_SECONDS,
    ExtensionIdentityUnknownError,
    ExtensionRefusedError,
    event_payload,
)


def _refused(refused: documents.RefusalError) -> ExtensionRefusedError:
    """A document-context refusal keeps its status, except the unknown principal, which is
    AUTHZ.md §2 step 6 and must surface as the shared `identity-unknown` answer."""
    if refused.status == 403 and refused.kind == "identity-unknown":
        return ExtensionIdentityUnknownError()
    return ExtensionRefusedError("extension_workspace_refused", refused.status)


def read_member(verified, organisation_id):
    if not organisation_exists(organisation_id=organisation_id):
        raise ExtensionRefusedError("extension_workspace_absent", 404)
    if WorkspaceCutoff.objects.filter(organisation_id=organisation_id).exists():
        raise ExtensionRefusedError("extension_workspace_cut_off", 410)
    try:
        workspace_id, principal = documents.read_context(verified, organisation_id)
    except documents.RefusalError as refused:
        raise _refused(refused) from None
    if principal.role not in {"org_owner", "org_admin", "org_billing", "org_member"}:
        raise ExtensionRefusedError("extension_member_required", 403)
    return workspace_id, principal


def member(verified, organisation_id):
    if not organisation_exists(organisation_id=organisation_id):
        raise ExtensionRefusedError("extension_workspace_absent", 404)
    if WorkspaceCutoff.objects.filter(organisation_id=organisation_id).exists():
        raise ExtensionRefusedError("extension_workspace_cut_off", 410)
    try:
        _, initial = documents.read_context(verified, organisation_id)
    except documents.RefusalError as refused:
        raise _refused(refused) from None
    initial_user_id = membership_user_id(membership_id=initial.membership_id)
    lock_erasure_cutoff_fences(organisation_id=organisation_id, user_id=initial_user_id)
    user_id = lock_membership_fence(membership_id=initial.membership_id)
    lock_delivery_identity(identity_id=initial.identity_id)
    lock_user_fence(user_id=user_id)
    if not lock_organisation(organisation_id=organisation_id):
        raise ExtensionRefusedError("extension_workspace_absent", 404)
    if WorkspaceCutoff.objects.filter(organisation_id=organisation_id).exists():
        raise ExtensionRefusedError("extension_workspace_cut_off", 410)
    try:
        workspace_id, principal = documents.write_context(verified, organisation_id)
    except documents.RefusalError as refused:
        raise _refused(refused) from None
    if (
        principal.membership_id != initial.membership_id
        or principal.identity_id != initial.identity_id
        or principal.role not in {"org_owner", "org_admin", "org_billing", "org_member"}
    ):
        raise ExtensionRefusedError("extension_member_required", 403)
    return workspace_id, principal


def read_admin(verified, organisation_id):
    if not organisation_exists(organisation_id=organisation_id):
        raise ExtensionRefusedError("extension_workspace_absent", 404)
    if WorkspaceCutoff.objects.filter(organisation_id=organisation_id).exists():
        raise ExtensionRefusedError("extension_workspace_cut_off", 410)
    try:
        workspace_id, principal = documents.read_context(verified, organisation_id)
    except documents.RefusalError as refused:
        raise _refused(refused) from None
    if principal.role not in {"org_owner", "org_admin"}:
        raise ExtensionRefusedError("extension_owner_or_admin_required", 403)
    return workspace_id, principal


def admin(verified, organisation_id):
    if not organisation_exists(organisation_id=organisation_id):
        raise ExtensionRefusedError("extension_workspace_absent", 404)
    if WorkspaceCutoff.objects.filter(organisation_id=organisation_id).exists():
        raise ExtensionRefusedError("extension_workspace_cut_off", 410)
    try:
        _, initial = documents.read_context(verified, organisation_id)
    except documents.RefusalError as refused:
        raise _refused(refused) from None
    initial_user_id = membership_user_id(membership_id=initial.membership_id)
    lock_erasure_cutoff_fences(organisation_id=organisation_id, user_id=initial_user_id)
    user_id = lock_membership_fence(membership_id=initial.membership_id)
    lock_delivery_identity(identity_id=initial.identity_id)
    lock_user_fence(user_id=user_id)
    if not lock_organisation(organisation_id=organisation_id):
        raise ExtensionRefusedError("extension_workspace_absent", 404)
    if WorkspaceCutoff.objects.filter(organisation_id=organisation_id).exists():
        raise ExtensionRefusedError("extension_workspace_cut_off", 410)
    # Re-read current authority after locking advisories -> m -> i -> u -> o -> w so any prior revocation wins.
    try:
        workspace_id, principal = documents.write_context(verified, organisation_id)
    except documents.RefusalError as refused:
        raise _refused(refused) from None
    if (
        principal.membership_id != initial.membership_id
        or principal.identity_id != initial.identity_id
        or principal.role not in {"org_owner", "org_admin"}
    ):
        raise ExtensionRefusedError("extension_owner_or_admin_required", 403)
    return workspace_id, principal


def audit(action, principal, organisation_id, target_id, metadata):
    record_extension_event(
        action=action,
        identity_id=None if principal is None else principal.identity_id,
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
        if event_type == "message.created":
            raw_ch = data.get("channel_id")
            raw_ev = data.get("matrix_event_id") or data.get("event_id")
            raw_sender = data.get("sender")
            raw_text = data.get("text")
            if (
                isinstance(raw_ch, (str, UUID))
                and isinstance(raw_ev, str)
                and isinstance(raw_sender, str)
                and isinstance(raw_text, str)
            ):
                try:
                    ch_uuid = raw_ch if isinstance(raw_ch, UUID) else UUID(raw_ch)
                except ValueError:
                    ch_uuid = None
                if ch_uuid is not None:
                    from . import coexistence

                    coexistence.enqueue_outbound_coexistence(
                        workspace_id=workspace_id,
                        channel_id=ch_uuid,
                        matrix_event_id=raw_ev,
                        sender=raw_sender,
                        sender_display_name=str(data.get("sender_display_name") or raw_sender),
                        text=raw_text,
                        msgtype=str(data.get("msgtype") or "m.text"),
                        metadata=data.get("metadata")
                        if isinstance(data.get("metadata"), dict)
                        else None,
                    )
    return delivery


@transaction.atomic
def emit_channel_message(
    *,
    verified,
    organisation_id: UUID,
    channel_id: UUID,
    matrix_event_id: str,
    sender: str,
    sender_display_name: str,
    text: str,
    msgtype: str = "m.text",
    metadata: dict[str, Any] | None = None,
) -> int:
    """Enqueue durable outbound coexistence deliveries for a local channel message."""
    from . import coexistence

    workspace_id, _ = admin(verified, organisation_id)
    queued = coexistence.enqueue_outbound_coexistence(
        workspace_id=workspace_id,
        channel_id=channel_id,
        matrix_event_id=matrix_event_id,
        sender=sender,
        sender_display_name=sender_display_name,
        text=text,
        msgtype=msgtype,
        metadata=metadata,
    )
    return len(queued)


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


def require_channel_post(
    *,
    channel_id: UUID,
    membership_id: UUID,
    organisation_id: UUID,
    allow_confidential_preview: bool = False,
    confidential_reason: str = "extension_confidential_channel_refused",
) -> None:
    """Resolve current channel access, including explicit administrator denials."""
    from apps.orgs.selectors import current_admin_role, organisation_authority_revision
    from apps.workspaces.channel_access import permits_channel_post
    from apps.workspaces.selectors import is_confidential_channel

    role = current_admin_role(membership_id=membership_id, organisation_id=organisation_id)
    if role is None or not permits_channel_post(
        channel_id=channel_id,
        membership_id=membership_id,
        organisation_id=organisation_id,
        member_org_role=role,
        authority_revision=organisation_authority_revision(organisation_id=organisation_id),
    ):
        raise ExtensionRefusedError("extension_channel_access_refused", 403)
    if not allow_confidential_preview and is_confidential_channel(
        channel_id=channel_id, organisation_id=organisation_id
    ):
        raise ExtensionRefusedError(confidential_reason, 403)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


_STORAGE_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())


def fetch_attachment_bytes(*, download_url: str, max_bytes: int = MAX_ARCHIVE) -> bytes:
    req = urllib.request.Request(  # noqa: S310 - presigned object-storage ticket from media Gateway
        download_url,
        headers={"Connection": "close"},
        method="GET",
    )
    try:
        with _STORAGE_OPENER.open(req, timeout=10.0) as resp:
            if resp.status != 200:
                raise ExtensionRefusedError("import_attachment_unavailable", 503)
            chunks: list[bytes] = []
            total = 0
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise ExtensionRefusedError("import_archive_bound", 413)
                chunks.append(chunk)
            return b"".join(chunks)
    except ExtensionRefusedError:
        raise
    except (urllib.error.HTTPError, urllib.error.URLError, OSError, HTTPException):
        raise ExtensionRefusedError("import_attachment_unavailable", 503) from None


def read_import_attachment(*, verified: Any, organisation_id: UUID, attachment_id: UUID) -> bytes:
    """Read and verify a scoped archive through the media service boundary."""
    try:
        ticket = media_services.get_attachment(
            verified=verified,
            organisation_id=organisation_id,
            attachment_id=attachment_id,
        )
    except MediaRefusalError as refused:
        raise ExtensionRefusedError("import_attachment_refused", refused.status) from None
    size_bytes = ticket.get("sizeBytes")
    if type(size_bytes) is not int or not 0 < size_bytes <= MAX_ARCHIVE:
        raise ExtensionRefusedError("import_archive_bound", 413)
    raw = fetch_attachment_bytes(download_url=str(ticket["downloadUrl"]), max_bytes=MAX_ARCHIVE)
    if len(raw) != size_bytes or hashlib.sha256(raw).hexdigest() != ticket.get("sha256"):
        raise ExtensionRefusedError("import_attachment_digest_mismatch", 409)
    return raw


def disarm_rehearsal_outbound(*, now: datetime) -> dict[str, int]:
    """Neutralize all outbound extension & coexistence endpoints inside an isolated rehearsal DB."""
    from django.db import connection
    from django.db.models import Q

    from .models import (
        CoexistenceBridge,
        CoexistenceReplayGuard,
        DeliveryAttempt,
        DigestConsent,
        DigestJob,
        ExtensionMarketplaceListing,
        MarketplaceEntitlement,
        WidgetActionReceipt,
    )

    if not connection.in_atomic_block:
        raise RuntimeError("disarm_rehearsal_outbound requires an enclosing atomic transaction")

    installations_revoked = Installation.objects.filter(revoked_at__isnull=True).update(
        revoked_at=now,
        updated_at=now,
    )
    DeliveryAttempt.objects.filter(outcome="started").update(
        outcome="obsolete",
        updated_at=now,
    )
    deliveries_obsoleted = Delivery.objects.filter(state__in=("pending", "in_flight")).update(
        state="obsolete",
        lease_id=None,
        lease_expires_at=None,
        outcome="rehearsal_disarmed",
        updated_at=now,
    )
    bridges_revoked = CoexistenceBridge.objects.filter(revoked_at__isnull=True).update(
        revoked_at=now,
        sealed_signing_secret=b"",
        updated_at=now,
    )
    secrets_zeroized = CoexistenceBridge.objects.filter(~Q(sealed_signing_secret=b"")).update(
        sealed_signing_secret=b"",
        updated_at=now,
    )
    replay_obsoleted = CoexistenceReplayGuard.objects.filter(
        direction="outbound",
        state__in=("queued", "in_flight", "retryable_failed"),
    ).update(
        state="obsolete",
        lease_id=None,
        lease_expires_at=None,
        sanitized_payload=None,
        updated_at=now,
    )
    DigestConsent.objects.filter(enabled=True).update(
        enabled=False,
        revoked_at=now,
        updated_at=now,
    )
    digest_jobs_obsoleted = DigestJob.objects.filter(state="pending").update(
        state="obsolete",
        updated_at=now,
    )
    listings_revoked = ExtensionMarketplaceListing.objects.filter(revoked_at__isnull=True).update(
        revoked_at=now,
        updated_at=now,
    )
    entitlements_revoked = MarketplaceEntitlement.objects.filter(
        Q(revoked_at__isnull=True) | ~Q(sealed_signing_secret=b"") | Q(checkout_url__isnull=False)
    ).update(
        state="revoked",
        revoked_at=now,
        sealed_signing_secret=b"",
        checkout_url=None,
        updated_at=now,
    )
    widget_receipts_cleared = WidgetActionReceipt.objects.filter(
        Q(state="in_flight") | Q(response_card__isnull=False)
    ).update(
        state="failed",
        response_card=None,
        updated_at=now,
    )
    return {
        "installations_revoked": installations_revoked,
        "deliveries_obsoleted": deliveries_obsoleted,
        "coexistence_bridges_revoked": bridges_revoked,
        "coexistence_secrets_zeroized": bridges_revoked + secrets_zeroized,
        "coexistence_outbound_obsoleted": replay_obsoleted,
        "digest_jobs_obsoleted": digest_jobs_obsoleted,
        "marketplace_listings_revoked": listings_revoked,
        "marketplace_entitlements_revoked": entitlements_revoked,
        "widget_action_receipts_cleared": widget_receipts_cleared,
    }


def record_workspace_cutoff(*, organisation_id: UUID, cutoff_at: datetime) -> bool:
    """Persist an anti-resurrection WorkspaceCutoff marker for an erased organisation."""
    _, created = WorkspaceCutoff.objects.get_or_create(
        organisation_id=organisation_id,
        defaults={"cutoff_at": cutoff_at},
    )
    return created


def has_workspace_cutoff(*, organisation_id: UUID) -> bool:
    """Return True when `organisation_id` is durably marked in `WorkspaceCutoff`."""
    return WorkspaceCutoff.objects.filter(organisation_id=organisation_id).exists()


def list_workspace_cutoff_ids() -> set[UUID]:
    """Return all organisation IDs recorded in `WorkspaceCutoff`."""
    return set(WorkspaceCutoff.objects.values_list("organisation_id", flat=True))


def count_residual_extension_rows_for_organisation(*, organisation_id: UUID) -> int:
    """Count unrevoked endpoints, unpurged webhook payloads, or unzeroized secrets for an erased org."""
    from django.db.models import Q

    from .models import (
        CoexistenceBridge,
        DigestConsent,
        ExtensionMarketplaceListing,
        MarketplaceEntitlement,
        WidgetActionReceipt,
    )

    active_installations = Installation.objects.filter(
        workspace__organisation_id=organisation_id,
        revoked_at__isnull=True,
    ).count()
    unpurged_deliveries = Delivery.objects.filter(
        installation__workspace__organisation_id=organisation_id,
        purged_at__isnull=True,
    ).count()
    active_or_secret_bridges = (
        CoexistenceBridge.objects.filter(
            workspace__organisation_id=organisation_id,
        )
        .filter(Q(revoked_at__isnull=True) | ~Q(sealed_signing_secret=b""))
        .count()
    )
    active_consents = DigestConsent.objects.filter(
        membership__organisation_id=organisation_id,
        enabled=True,
    ).count()
    active_listings = ExtensionMarketplaceListing.objects.filter(
        organisation_id=organisation_id,
        revoked_at__isnull=True,
    ).count()
    active_or_secret_entitlements = (
        MarketplaceEntitlement.objects.filter(organisation_id=organisation_id)
        .filter(
            ~Q(state__in=("revoked", "refunded"))
            | Q(revoked_at__isnull=True)
            | ~Q(sealed_signing_secret=b"")
        )
        .count()
    )
    unpurged_widget_receipts = WidgetActionReceipt.objects.filter(
        organisation_id=organisation_id,
        response_card__isnull=False,
    ).count()
    return (
        active_installations
        + unpurged_deliveries
        + active_or_secret_bridges
        + active_consents
        + active_listings
        + active_or_secret_entitlements
        + unpurged_widget_receipts
    )
