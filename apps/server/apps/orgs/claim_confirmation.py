"""Intake recorder's independent confirmation; reuse the existing audit gate."""

from uuid import UUID

from django.db import connection, transaction

from apps.audit.selectors import claim_confirmation_recorded
from apps.audit.services import record_owner_event
from apps.identity.staff import StaffPrincipal

from .models import OrganisationIntake, OwnerClaim
from .owner_claims import ClaimRefusedError, _reference, authorized_operator


def confirm_owner_contact(
    *,
    principal: StaffPrincipal,
    organisation_id: UUID,
    claim_id: UUID,
    evidence_ref: str,
    request_id: str,
) -> bool:
    _reference(evidence_ref)
    _reference(request_id)
    if connection.in_atomic_block:
        raise RuntimeError("owner confirmation requires its own transaction")
    with authorized_operator(principal), transaction.atomic():
        intake = OrganisationIntake.objects.filter(organisation_id=organisation_id).first()
        if intake is None or intake.recorded_by_identity_id != principal.identity_id:
            raise ClaimRefusedError("intake_recorder_required")
        claim = (
            OwnerClaim.objects.select_for_update()
            .filter(id=claim_id, organisation_id=organisation_id)
            .first()
        )
        if claim is None or claim.state != "consumed":
            raise ClaimRefusedError("consumed_claim_required")
        if claim_confirmation_recorded(organisation_id=organisation_id, claim_id=claim.id):
            return False
        record_owner_event(
            action="owner_claim.confirmed",
            organisation_id=organisation_id,
            target_id=claim.id,
            actor_id=principal.identity_id,
            request_id=request_id,
            metadata={"evidence_ref": evidence_ref},
        )
        return True
