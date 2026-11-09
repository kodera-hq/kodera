"""Excluded operator-only fresh identity creation; no email-based account linking."""

from dataclasses import dataclass
from uuid import UUID

from django.db import connection

from .models import Identity, User


@dataclass(frozen=True, slots=True)
class CreatedOwnerIdentity:
    identity_id: UUID
    user_id: UUID


def account_subject_exists(*, issuer: str, subject: str) -> bool:
    return Identity.objects.filter(issuer=issuer, subject=subject).exists()


def create_owner_identity(
    *,
    organisation_id: UUID,
    issuer: str,
    realm: str,
    subject: str,
    contact: str,
    display_name: str | None,
) -> CreatedOwnerIdentity:
    """Caller owns authorization, validation and atomic rollback; no model escapes."""
    if not connection.in_atomic_block:
        raise RuntimeError("owner identity creation requires caller transaction")
    person = User.objects.create(email=contact, display_name=display_name, enabled=True)
    identity = Identity.objects.create(
        user_id=person.id,
        organisation_id=organisation_id,
        issuer=issuer,
        realm=realm,
        subject=subject,
        email=contact,
        enabled=True,
    )
    return CreatedOwnerIdentity(identity.id, person.id)
