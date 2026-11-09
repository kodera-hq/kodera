"""Counting readiness and materialized bootstrap facts; no operator orchestration."""

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from django.conf import settings

from apps.jobs.selectors import latest_job_state
from services.identity.trusted_issuers import is_trusted_issuer

from .models import Organisation, OrganisationIntake, OwnerBinding, OwnerClaim, RealmReadiness


@dataclass(frozen=True, slots=True, repr=False)
class BootstrapView:
    organisation_id: UUID
    slug: str
    organisation_state: str
    instruction_ref: str
    recorded_at: datetime
    intended_owner_email_masked: str
    realm_state: str
    realm_name: str | None
    job_id: UUID
    identity_state: str
    identity_id: UUID | None
    bound_at: datetime | None
    claim_state: str
    issued_at: datetime | None
    expires_at: datetime | None
    consumed_at: datetime | None
    revoked_at: datetime | None
    membership_id: UUID | None
    updated_at: datetime


def counting_realm_ready(*, organisation_id: UUID) -> bool:
    organisation = (
        Organisation.objects.filter(id=organisation_id, deleted_at__isnull=True)
        .values_list("issuer", "realm")
        .first()
    )
    if organisation is None:
        return False
    issuer, realm = organisation
    job = latest_job_state(organisation_id=organisation_id, kind="realm_create")
    if job is None or job.status != "succeeded":
        return False
    recorded = _recorded_realm_ready(
        organisation_id=organisation_id, job_id=job.id, issuer=issuer, realm=realm
    )
    return recorded and is_trusted_issuer(issuer, trusted=settings.KODERA_AUTH_TRUST)


def _recorded_realm_ready(*, organisation_id: UUID, job_id: UUID, issuer: str, realm: str) -> bool:
    """A matching unrevoked fact, independent of today's trust; caller binds latest success."""
    return RealmReadiness.objects.filter(
        organisation_id=organisation_id,
        job_id=job_id,
        issuer=issuer,
        realm=realm,
        revoked_at__isnull=True,
    ).exists()


def bootstrap_view(*, organisation_id: UUID) -> BootstrapView | None:
    organisation = (
        Organisation.objects.filter(id=organisation_id, deleted_at__isnull=True)
        .only("id", "slug", "state", "issuer", "realm", "updated_at")
        .first()
    )
    intake = (
        OrganisationIntake.objects.filter(organisation_id=organisation_id)
        .only("instruction_ref", "created_at", "intended_owner_email_masked", "bootstrap_job_id")
        .first()
    )
    if organisation is None or intake is None:
        return None
    job = latest_job_state(organisation_id=organisation_id, kind="realm_create")
    recorded = bool(
        job
        and job.status == "succeeded"
        and _recorded_realm_ready(
            organisation_id=organisation_id,
            job_id=job.id,
            issuer=organisation.issuer,
            realm=organisation.realm,
        )
    )
    trusted = is_trusted_issuer(organisation.issuer, trusted=settings.KODERA_AUTH_TRUST)
    ready = recorded and trusted
    realm_state = (
        "ready"
        if ready
        else "failed"
        if (recorded and not trusted) or (job and job.status in {"failed", "cancelled"})
        else "running"
        if job and job.status in {"leased", "running", "orphaned", "needs_reconciliation"}
        else "pending"
    )
    binding = (
        OwnerBinding.objects.filter(organisation_id=organisation_id)
        .only("id", "identity_id", "recorded_at")
        .first()
    )
    eligible = (
        binding is not None
        and OwnerBinding.objects.filter(
            id=binding.id,
            identity__enabled=True,
            identity__deleted_at__isnull=True,
            identity__user__enabled=True,
            identity__user__deleted_at__isnull=True,
        ).exists()
    )
    claim = (
        OwnerClaim.objects.filter(organisation_id=organisation_id)
        .only("state", "issued_at", "expires_at", "consumed_at", "revoked_at", "membership_id")
        .order_by("-issued_at", "-id")
        .first()
    )
    updated = [organisation.updated_at, intake.created_at]
    if binding:
        updated.append(binding.recorded_at)
    if claim:
        updated.extend(
            instant
            for instant in (claim.issued_at, claim.consumed_at, claim.revoked_at)
            if instant is not None
        )
    return BootstrapView(
        organisation.id,
        organisation.slug,
        organisation.state,
        intake.instruction_ref,
        intake.created_at,
        intake.intended_owner_email_masked,
        realm_state,
        organisation.realm if recorded else None,
        job.id if job else intake.bootstrap_job_id,
        "ready" if recorded and eligible else "pending",
        binding.identity_id if binding else None,
        binding.recorded_at if binding else None,
        claim.state if claim else "not_issued",
        claim.issued_at if claim else None,
        claim.expires_at if claim else None,
        claim.consumed_at if claim else None,
        claim.revoked_at if claim else None,
        claim.membership_id if claim else None,
        max(updated),
    )
