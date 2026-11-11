"""Identity-owned canonical signup and explicit operator-proven account bindings."""

from dataclasses import dataclass
from uuid import UUID

from django.core.exceptions import ValidationError
from django.core.validators import validate_email

from services.identity.access_tokens import VerifiedAccessToken

from .models import Identity, User
from .selectors import PersonSnapshot, is_storable_subject


@dataclass(frozen=True, slots=True, repr=False)
class CommunityPrincipal:
    id: UUID
    user_id: UUID
    issuer: str
    realm: str
    subject: str
    email: str
    user: PersonSnapshot


def _snapshot(principal: Identity) -> CommunityPrincipal:
    return CommunityPrincipal(
        principal.id,
        principal.user_id,
        principal.issuer,
        principal.realm,
        principal.subject,
        principal.email,
        PersonSnapshot(principal.user_id, principal.user.email, principal.user.display_name),
    )


def require_enabled_person(user_id: UUID) -> None:
    User.objects.get(id=user_id, enabled=True, deleted_at__isnull=True)


def lock_person(user_id: UUID) -> None:
    """Serialize per-person quotas across all their issuer identities in the caller transaction."""
    User.objects.select_for_update().get(id=user_id)


def community_identity(verified: VerifiedAccessToken) -> CommunityPrincipal | None:
    if not is_storable_subject(verified.subject):
        return None
    principal = (
        Identity.objects.select_related("user")
        .filter(
            issuer=verified.issuer,
            subject=verified.subject,
            enabled=True,
            deleted_at__isnull=True,
            user__enabled=True,
            user__deleted_at__isnull=True,
        )
        .first()
    )

    return None if principal is None else _snapshot(principal)


def materialize_community_identity(
    *, verified: VerifiedAccessToken, organisation_id: UUID, issuer: str, realm: str
) -> CommunityPrincipal | None:
    """Called under the canonical organisation lock; never match an existing account by email."""
    if Identity.objects.filter(issuer=verified.issuer, subject=verified.subject).exists():
        return None
    if verified.issuer != issuer or not verified.email_verified or not verified.email:
        return None
    try:
        validate_email(verified.email)
    except ValidationError:
        return None
    if len(verified.email) > 254:
        return None
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


def bind_proven_community_identity(
    *, user_id: UUID, subject: str, organisation_id: UUID, issuer: str, realm: str
) -> CommunityPrincipal:
    user = User.objects.get(id=user_id, enabled=True, deleted_at__isnull=True)
    principal, _ = Identity.objects.get_or_create(
        issuer=issuer,
        subject=subject,
        defaults={
            "user": user,
            "organisation_id": organisation_id,
            "realm": realm,
            "email": user.email,
        },
    )
    if principal.user_id != user.id or not principal.enabled or principal.deleted_at is not None:
        raise ValueError("The realm subject already has a different or disabled binding")
    return _snapshot(principal)
