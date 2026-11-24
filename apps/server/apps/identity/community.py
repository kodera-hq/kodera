"""Identity-owned canonical signup and explicit operator-proven account bindings."""

from dataclasses import dataclass
from uuid import UUID

from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import connection, transaction

from services.identity.access_tokens import VerifiedAccessToken

from .models import Identity, User
from .selectors import IdentitySnapshot, PersonSnapshot, is_storable_subject


def lock_identity_principal(*, issuer: str, subject: str) -> None:
    """Serialize `(issuer, subject)` person resolution and creation across concurrent transactions."""
    if not connection.in_atomic_block:
        raise RuntimeError("identity principal lock requires an atomic transaction")
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT pg_advisory_xact_lock("
            "hashtextextended('identity_principal:' || %s || ':' || %s, 0))",
            [issuer, subject],
        )


@dataclass(frozen=True, slots=True, repr=False)
class CommunityPrincipal:
    id: UUID
    user_id: UUID
    issuer: str
    realm: str
    subject: str
    email: str
    user: PersonSnapshot
    organisation_id: UUID | None = None


def _snapshot(principal: Identity) -> CommunityPrincipal:
    return CommunityPrincipal(
        principal.id,
        principal.user_id,
        principal.issuer,
        principal.realm,
        principal.subject,
        principal.email,
        PersonSnapshot(principal.user_id, principal.user.email, principal.user.display_name),
        principal.organisation_id,
    )


def require_enabled_person(user_id: UUID) -> None:
    User.objects.get(id=user_id, enabled=True, deleted_at__isnull=True)


def lock_person(user_id: UUID) -> None:
    """Serialize per-person quotas across all their issuer identities in the caller transaction."""
    User.objects.select_for_update().get(id=user_id)


def community_identity(
    verified: VerifiedAccessToken, *, organisation_id: UUID | None = None
) -> CommunityPrincipal | None:
    if not is_storable_subject(verified.subject):
        return None
    from django.db.models import F

    rows = Identity.objects.select_related("user").filter(
        issuer=verified.issuer,
        subject=verified.subject,
        enabled=True,
        deleted_at__isnull=True,
        user__enabled=True,
        user__deleted_at__isnull=True,
    )
    if organisation_id is not None:
        rows = rows.filter(organisation_id=organisation_id)
    principal = rows.order_by(
        F("organisation__is_default_community").desc(nulls_last=True), "id"
    ).first()

    return None if principal is None else _snapshot(principal)


def materialize_community_identity(
    *, verified: VerifiedAccessToken, organisation_id: UUID, issuer: str, realm: str
) -> CommunityPrincipal | None:
    """Never match an existing account by email. Serializes on `(issuer, subject)` advisory lock
    before person lookup/creation so concurrent first visits across shared-realm surfaces bind one
    canonical `User` row."""
    if verified.issuer != issuer or not verified.email_verified or not verified.email:
        return None
    try:
        validate_email(verified.email)
    except ValidationError:
        return None
    if len(verified.email) > 254:
        return None
    with transaction.atomic():
        lock_identity_principal(issuer=verified.issuer, subject=verified.subject)
        if Identity.objects.filter(
            organisation_id=organisation_id, issuer=verified.issuer, subject=verified.subject
        ).exists():
            return None
        existing = (
            Identity.objects.select_related("user")
            .filter(
                issuer=verified.issuer,
                subject=verified.subject,
                organisation__isnull=False,
            )
            .order_by("-organisation__is_default_community", "id")
            .first()
        )
        if existing is not None:
            if not existing.user.enabled or existing.user.deleted_at is not None:
                return None
            user = existing.user
        else:
            user = User.objects.create(email=verified.email)
        principal = Identity.objects.create(
            user=user,
            organisation_id=organisation_id,
            issuer=issuer,
            realm=realm,
            subject=verified.subject,
            email=verified.email,
        )
        return _snapshot(principal)


def ensure_shared_realm_identity(
    *,
    verified: VerifiedAccessToken,
    organisation_id: UUID,
    issuer: str,
    realm: str,
    display_name: str | None = None,
) -> tuple[PersonSnapshot, IdentitySnapshot] | None:
    """Resolve or materialize `(Person, Identity)` in a `shared_realm=True` organisation."""
    if not is_storable_subject(verified.subject):
        return None
    if verified.issuer != issuer or not verified.email_verified or not verified.email:
        return None
    try:
        validate_email(verified.email)
    except ValidationError:
        return None
    if len(verified.email) > 254:
        return None

    with transaction.atomic():
        lock_identity_principal(issuer=issuer, subject=verified.subject)
        in_org = (
            Identity.objects.select_related("user")
            .filter(organisation_id=organisation_id, issuer=issuer, subject=verified.subject)
            .first()
        )
        if in_org is not None:
            if (
                not in_org.enabled
                or in_org.deleted_at is not None
                or not in_org.user.enabled
                or in_org.user.deleted_at is not None
            ):
                return None
            user = in_org.user
            return (
                PersonSnapshot(user.id, user.email, user.display_name),
                IdentitySnapshot(
                    in_org.id,
                    organisation_id,
                    in_org.issuer,
                    in_org.realm,
                    in_org.subject,
                    in_org.email,
                ),
            )

        existing = (
            Identity.objects.select_related("user")
            .filter(issuer=issuer, subject=verified.subject, organisation__isnull=False)
            .order_by("-organisation__is_default_community", "id")
            .first()
        )
        if existing is not None:
            if not existing.user.enabled or existing.user.deleted_at is not None:
                return None
            user = existing.user
            if display_name and not user.display_name:
                user.display_name = display_name
                user.save(update_fields=["display_name", "updated_at"])
        else:
            user = User.objects.create(email=verified.email, display_name=display_name)

        created = Identity.objects.create(
            user=user,
            organisation_id=organisation_id,
            issuer=issuer,
            realm=realm,
            subject=verified.subject,
            email=verified.email,
        )
        return (
            PersonSnapshot(user.id, user.email, user.display_name),
            IdentitySnapshot(
                created.id,
                organisation_id,
                created.issuer,
                created.realm,
                created.subject,
                created.email,
            ),
        )


def bind_proven_community_identity(
    *, user_id: UUID, subject: str, organisation_id: UUID, issuer: str, realm: str
) -> CommunityPrincipal:
    user = User.objects.get(id=user_id, enabled=True, deleted_at__isnull=True)
    principal, _ = Identity.objects.get_or_create(
        organisation_id=organisation_id,
        issuer=issuer,
        subject=subject,
        defaults={
            "user": user,
            "realm": realm,
            "email": user.email,
        },
    )
    if principal.user_id != user.id or not principal.enabled or principal.deleted_at is not None:
        raise ValueError("The realm subject already has a different or disabled binding")
    return _snapshot(principal)


def resolve_or_create_locked_self_serve_person(
    *, issuer: str, subject: str, email: str
) -> tuple[UUID, bool]:
    """Resolve existing `Person` on `(issuer, subject)` or create one, locking `User` `FOR UPDATE`."""
    lock_identity_principal(issuer=issuer, subject=subject)
    existing = (
        Identity.objects.select_related("user")
        .filter(
            issuer=issuer,
            subject=subject,
            organisation__isnull=False,
        )
        .order_by("-organisation__is_default_community", "id")
        .first()
    )
    if existing is not None:
        person = User.objects.select_for_update().get(id=existing.user_id)
        return person.id, (person.enabled and person.deleted_at is None)
    created = User.objects.create(email=email, enabled=True)
    locked = User.objects.select_for_update().get(id=created.id)
    return locked.id, True


def create_self_serve_owner_identity(
    *,
    user_id: UUID,
    organisation_id: UUID,
    issuer: str,
    realm: str,
    subject: str,
    email: str,
) -> UUID:
    """Create the enabled customer `Identity` for a newly provisioned self-serve PME organisation."""
    identity = Identity.objects.create(
        user_id=user_id,
        organisation_id=organisation_id,
        issuer=issuer,
        realm=realm,
        subject=subject,
        email=email,
        enabled=True,
    )
    return identity.id
