"""Explicit opt-in metadata digests, re-authorized at the actual bounded SMTP boundary."""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timedelta
from uuid import UUID

from django.db import connection, transaction
from django.utils import timezone

from apps.docs import services as documents
from apps.docs.models import Collection, Document
from apps.identity.models import Identity
from apps.orgs.models import Membership, Organisation
from apps.outbox.services import enqueue_message
from apps.workspaces.models import Workspace, WorkspaceMemberRestriction
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


def current(row: DigestConsent) -> tuple[Membership, Identity, UUID] | None:
    if not row.enabled or row.revoked_at is not None or row.consented_at is None:
        return None
    member = (
        Membership.objects.filter(
            id=row.membership_id,
            state="active",
            accepted_at__isnull=False,
            deleted_at__isnull=True,
            user__enabled=True,
            user__deleted_at__isnull=True,
            organisation__state="active",
            organisation__deleted_at__isnull=True,
        )
        .select_related("user")
        .first()
    )
    identity = Identity.objects.filter(
        id=row.identity_id, enabled=True, deleted_at__isnull=True
    ).first()
    if (
        member is None
        or identity is None
        or identity.user_id != member.user_id
        or identity.organisation_id != member.organisation_id
        or identity.email != member.user.email
    ):
        return None
    if WorkspaceCutoff.objects.filter(organisation_id=member.organisation_id).exists():
        return None
    workspace = Workspace.objects.filter(organisation_id=member.organisation_id).first()
    if (
        workspace is None
        or WorkspaceMemberRestriction.objects.filter(workspace=workspace, membership=member)
        .filter(banned=True)
        .exists()
        or WorkspaceMemberRestriction.objects.filter(
            workspace=workspace, membership=member, kicked=True
        ).exists()
    ):
        return None
    return member, identity, workspace.id


def visible(document_id: UUID, member: Membership, identity: Identity) -> bool:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT docs_document_role(%s,%s,%s,%s,%s,%s)",
            [
                document_id,
                member.organisation_id,
                member.id,
                identity.id,
                identity.issuer,
                identity.subject,
            ],
        )
        return cursor.fetchone()[0] in {"viewer", "editor"}


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
    Organisation.objects.select_for_update().get(id=organisation_id)
    Workspace.objects.select_for_update().get(organisation_id=organisation_id)
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
        doc.id
        for doc in Document.objects.filter(
            workspace_id=workspace_id,
            deleted_at__isnull=True,
            updated_at__gte=period_start,
            updated_at__lt=period_end,
        ).order_by("id")[:1000]
        if visible(doc.id, member, identity)
    ]
    tables = list(
        Collection.objects.filter(
            workspace_id=workspace_id,
            deleted_at__isnull=True,
            updated_at__gte=period_start,
            updated_at__lt=period_end,
        )
        .order_by("id")
        .values_list("id", flat=True)[:1000]
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
            recipient=member.user.email,
            params={
                "organisation_name": member.organisation.name,
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
        Organisation.objects.select_for_update().get(id=org_id)
        workspace = Workspace.objects.select_for_update().get(organisation_id=org_id)
        Membership.objects.select_for_update().select_related("user").get(
            id=record["consent__membership_id"]
        )
        Identity.objects.select_for_update().get(id=record["consent__identity_id"])
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
                and recipient == member.user.email
                and len(job.document_ids) <= 1000
                and len(job.collection_ids) <= 1000
                and all(visible(UUID(value), member, identity) for value in job.document_ids)
                and Collection.objects.filter(
                    id__in=job.collection_ids, workspace=workspace, deleted_at__isnull=True
                ).count()
                == len(job.collection_ids)
            )
        if not allowed:
            job.state = "obsolete"
            job.save(update_fields=["state", "updated_at"])
        yield allowed
