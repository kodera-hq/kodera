"""Explicit opt-in metadata digests, re-authorized at the actual bounded SMTP boundary."""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timedelta
from uuid import UUID

from django.db import transaction
from django.utils import timezone

from apps.docs import selectors as document_reads, services as documents
from apps.identity import selectors as identities
from apps.orgs import selectors as organisations
from apps.outbox.services import enqueue_message
from apps.workspaces import selectors as workspaces
from core.db.ids import new_uuid7

from .models import DigestConsent, DigestJob, WorkspaceCutoff
from .services import audit
from .wire import ExtensionRefusedError


@transaction.atomic
def set_consent(
    *, verified, organisation_id: UUID, enabled: bool, locale: str = "en"
) -> DigestConsent:
    if enabled and WorkspaceCutoff.objects.filter(organisation_id=organisation_id).exists():
        raise ExtensionRefusedError("extension_workspace_cut_off", 410)
    _, principal = documents.context(verified, organisation_id)
    if enabled and WorkspaceCutoff.objects.filter(organisation_id=organisation_id).exists():
        raise ExtensionRefusedError("extension_workspace_cut_off", 410)
    if type(enabled) is not bool or locale not in {"en", "fr"}:
        raise ExtensionRefusedError("digest_consent_invalid")
    row, _ = DigestConsent.objects.get_or_create(
        membership_id=principal.membership_id, defaults={"identity_id": principal.identity_id}
    )
    row = DigestConsent.objects.select_for_update().get(id=row.id)
    row.identity_id, row.enabled, row.locale, row.version = (
        principal.identity_id,
        enabled,
        locale,
        new_uuid7(),
    )
    row.consented_at = timezone.now() if enabled else row.consented_at
    row.revoked_at = None if enabled else timezone.now()
    row.save(
        update_fields=[
            "identity",
            "enabled",
            "locale",
            "version",
            "consented_at",
            "revoked_at",
            "updated_at",
        ]
    )
    if not enabled:
        DigestJob.objects.filter(consent=row, state="pending").update(
            state="obsolete", updated_at=timezone.now()
        )
    audit(
        "digest_consent_changed",
        principal,
        organisation_id,
        row.id,
        {"enabled": enabled, "consent_version": str(row.version)},
    )
    return row


def current(
    row: DigestConsent,
) -> tuple[organisations.MembershipContact, identities.DeliveryIdentity, UUID] | None:
    if not row.enabled or row.revoked_at is not None or row.consented_at is None:
        return None
    member = organisations.digest_member(membership_id=row.membership_id)
    identity = identities.delivery_identity(identity_id=row.identity_id)
    if (
        member is None
        or identity is None
        or identity.user_id != member.user_id
        or identity.organisation_id != member.organisation_id
        or identity.email != member.email
    ):
        return None
    if WorkspaceCutoff.objects.filter(organisation_id=member.organisation_id).exists():
        return None
    workspace_id = workspaces.digest_workspace(
        organisation_id=member.organisation_id, membership_id=member.id
    )
    return None if workspace_id is None else (member, identity, workspace_id)


def visible(document_id, member, identity) -> bool:
    return document_reads.document_is_visible(
        document_id=document_id,
        organisation_id=member.organisation_id,
        membership_id=member.id,
        identity_id=identity.id,
        issuer=identity.issuer,
        subject=identity.subject,
    )


@transaction.atomic
def enqueue_digest(*, consent_id: UUID, period_start: datetime, period_end: datetime) -> DigestJob:
    if (
        period_start.tzinfo is None
        or period_end.tzinfo is None
        or not period_start < period_end <= timezone.now()
        or period_end - period_start > timedelta(days=7)
    ):
        raise ExtensionRefusedError("digest_period_invalid")
    # Current organisation/workspace fences precede consent, matching installation dispatch.
    organisation_id = DigestConsent.objects.values_list(
        "membership__organisation_id", flat=True
    ).get(id=consent_id)
    if not organisations.lock_organisation(organisation_id=organisation_id):
        raise LookupError("digest organisation absent")
    workspaces.lock_organisation_workspace(organisation_id=organisation_id)
    row = DigestConsent.objects.select_for_update().get(id=consent_id)
    authority = current(row)
    if authority is None:
        raise ExtensionRefusedError("digest_consent_not_current", 403)
    old = DigestJob.objects.filter(
        consent=row, period_start=period_start, period_end=period_end
    ).first()
    if old is not None:
        return old
    member, identity, workspace_id = authority
    pages = [
        document_id
        for document_id in document_reads.digest_document_candidates(
            workspace_id=workspace_id, period_start=period_start, period_end=period_end
        )
        if visible(document_id, member, identity)
    ]
    tables = document_reads.digest_collections(
        workspace_id=workspace_id, period_start=period_start, period_end=period_end
    )
    job = DigestJob.objects.create(
        consent=row,
        consent_version=row.version,
        period_start=period_start,
        period_end=period_end,
        document_ids=[str(value) for value in pages],
        collection_ids=[str(value) for value in tables],
    )
    if not pages and not tables:
        job.state = "obsolete"
    else:
        job.delivery_id = enqueue_message(
            organisation_id=member.organisation_id,
            template_id="workspace_digest",
            locale=row.locale,
            recipient=member.email,
            params={
                "organisation_name": member.organisation_name,
                "updated_pages": str(len(pages)),
                "updated_collections": str(len(tables)),
                "period_start": period_start.date().isoformat(),
                "period_end": period_end.date().isoformat(),
            },
            expires_at=timezone.now() + timedelta(days=1),
        )
        job.state = "enqueued"
    job.save(update_fields=["delivery_id", "state", "updated_at"])
    return job


@contextmanager
def send_guard(delivery_id: UUID, recipient: str):
    """A committed revocation wins before SMTP; no snapshot alone authorizes disclosure."""
    with transaction.atomic():
        record = (
            DigestJob.objects.filter(delivery_id=delivery_id)
            .values(
                "consent__membership__organisation_id",
                "consent__membership_id",
                "consent__identity_id",
                "consent_id",
            )
            .first()
        )
        if record is None:
            yield False
            return
        org_id = record["consent__membership__organisation_id"]
        if not organisations.lock_organisation(organisation_id=org_id):
            raise LookupError("digest organisation absent")
        workspace_id = workspaces.lock_organisation_workspace(organisation_id=org_id)
        organisations.lock_membership_user(membership_id=record["consent__membership_id"])
        identities.lock_delivery_identity(identity_id=record["consent__identity_id"])
        consent = DigestConsent.objects.select_for_update().get(id=record["consent_id"])
        job = DigestJob.objects.select_for_update().get(delivery_id=delivery_id)
        authority = current(consent)
        allowed = (
            authority is not None
            and job.state == "enqueued"
            and job.consent_version == consent.version
        )
        if authority is not None:
            member, identity, _ = authority
            allowed = (
                allowed
                and recipient == member.email
                and len(job.document_ids) <= 1000
                and len(job.collection_ids) <= 1000
                and all(visible(UUID(value), member, identity) for value in job.document_ids)
                and document_reads.digest_collection_count(
                    collection_ids=job.collection_ids, workspace_id=workspace_id
                )
                == len(job.collection_ids)
            )
        if not allowed:
            job.state = "obsolete"
            job.save(update_fields=["state", "updated_at"])
        yield allowed
