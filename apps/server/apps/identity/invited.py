"""The identity an accepted invitation creates (docs/specs/INVITATIONS.md §5).

Accepting is how a customer identity comes to exist for an invitee (docs/api/AUTHZ.md §2 step 6):
the caller's verified `(iss, sub)` and the invitation's address, never an account matched by
address. The caller owns authorisation and the transaction.
"""

from dataclasses import dataclass
from uuid import UUID

from django.db import connection

from .models import Identity, User


@dataclass(frozen=True, slots=True, repr=False)
class KnownSubject:
    identity_id: UUID
    user_id: UUID
    usable: bool
    email: str
    display_name: str | None


def known_subject(
    *, issuer: str, subject: str, organisation_id: UUID | None = None
) -> KnownSubject | None:
    """The stored customer identity of `(iss, sub)`, usable or not, with its person's contact."""
    if organisation_id is not None:
        in_org = (
            Identity.objects.select_related("user")
            .filter(organisation_id=organisation_id, issuer=issuer, subject=subject)
            .first()
        )
        if in_org is not None:
            person = in_org.user
            usable = (
                in_org.enabled
                and in_org.deleted_at is None
                and person.enabled
                and person.deleted_at is None
            )
            return KnownSubject(in_org.id, person.id, usable, person.email, person.display_name)
    identity = (
        Identity.objects.select_related("user")
        .filter(issuer=issuer, subject=subject, organisation__isnull=False)
        .order_by("-organisation__is_default_community", "id")
        .first()
    )
    if identity is None:
        return None
    person = identity.user
    usable = (
        (identity.enabled and identity.deleted_at is None if organisation_id is None else True)
        and person.enabled
        and person.deleted_at is None
    )
    return KnownSubject(identity.id, person.id, usable, person.email, person.display_name)


def identity_person(*, identity_id: UUID) -> UUID:
    """The person of a stored identity."""
    user_id: UUID = Identity.objects.values_list("user_id", flat=True).get(id=identity_id)
    return user_id


def person_display_name(*, user_id: UUID) -> str | None:
    """The display name a person set, or None when they set none or the person is deleted."""
    name: str | None = (
        User.objects.filter(id=user_id, deleted_at__isnull=True)
        .values_list("display_name", flat=True)
        .first()
    )
    return name


def create_invited_identity(
    *,
    organisation_id: UUID,
    issuer: str,
    realm: str,
    subject: str,
    contact: str,
    display_name: str | None,
) -> KnownSubject:
    """A new person and their identity in the organisation's realm, in the caller's transaction."""
    if not connection.in_atomic_block:
        raise RuntimeError("invited identity creation requires the caller's transaction")
    from .community import lock_identity_principal

    lock_identity_principal(issuer=issuer, subject=subject)
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
    return KnownSubject(identity.id, person.id, True, contact, display_name)


def ensure_invited_identity_for_organisation(
    *,
    organisation_id: UUID,
    issuer: str,
    realm: str,
    subject: str,
    contact: str,
    display_name: str | None,
) -> KnownSubject | None:
    """Resolve or bind `(Person, Identity)` in `organisation_id` during invitation acceptance."""
    if not connection.in_atomic_block:
        raise RuntimeError("invited identity creation requires the caller's transaction")
    from .community import lock_identity_principal

    lock_identity_principal(issuer=issuer, subject=subject)
    in_org = (
        Identity.objects.select_related("user")
        .filter(organisation_id=organisation_id, issuer=issuer, subject=subject)
        .first()
    )
    if in_org is not None:
        person = in_org.user
        usable = (
            in_org.enabled
            and in_org.deleted_at is None
            and person.enabled
            and person.deleted_at is None
        )
        return (
            KnownSubject(in_org.id, person.id, True, person.email, person.display_name)
            if usable
            else None
        )
    existing = (
        Identity.objects.select_related("user")
        .filter(issuer=issuer, subject=subject, organisation__isnull=False)
        .order_by("-organisation__is_default_community", "id")
        .first()
    )
    if existing is None:
        return create_invited_identity(
            organisation_id=organisation_id,
            issuer=issuer,
            realm=realm,
            subject=subject,
            contact=contact,
            display_name=display_name,
        )
    person = existing.user
    if not person.enabled or person.deleted_at is not None:
        return None
    if display_name and not person.display_name:
        person.display_name = display_name
        person.save(update_fields=["display_name", "updated_at"])
    created = Identity.objects.create(
        user_id=person.id,
        organisation_id=organisation_id,
        issuer=issuer,
        realm=realm,
        subject=subject,
        email=contact,
        enabled=True,
    )
    return KnownSubject(created.id, person.id, True, person.email, person.display_name)
