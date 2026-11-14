"""Current customer grant and the explicit authenticated-person switcher projection."""

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from django.db.models import QuerySet

from .models import Membership, Organisation


@dataclass(frozen=True, slots=True, repr=False)
class OrganisationSnapshot:
    id: UUID
    slug: str
    name: str
    realm: str


@dataclass(frozen=True, slots=True, repr=False)
class MembershipSnapshot:
    id: UUID
    organisation: OrganisationSnapshot
    role: str
    state: str
    accepted_at: datetime | None


def _organisation_memberships(*, organisation_id: UUID) -> QuerySet[Membership]:
    """The one current-membership predicate: undeleted, active, accepted, known role.

    Every grant and membership lookup in this module narrows this queryset rather
    than restating it, so the predicate cannot drift between callers.
    """
    return Membership.objects.filter(
        organisation_id=organisation_id,
        deleted_at__isnull=True,
        state=Membership.State.ACTIVE,
        accepted_at__isnull=False,
        role__in=Membership.Role.values,
    )


def _current_memberships(*, user_id: UUID, organisation_id: UUID) -> QuerySet[Membership]:
    """One person's current membership, by the predicate above."""
    return _organisation_memberships(organisation_id=organisation_id).filter(user_id=user_id)


def current_member_roles(*, organisation_id: UUID) -> dict[UUID, str]:
    """Every current membership of the organisation, by id, with its stored role, read in the
    caller's transaction (docs/specs/ESPACE_STRUCTURE.md §§6, 9)."""
    return dict(
        _organisation_memberships(organisation_id=organisation_id).values_list("id", "role")
    )


def current_members(*, organisation_id: UUID) -> dict[UUID, tuple[UUID, str]]:
    """Every current membership of the organisation, by id, with its person and stored role, read
    in the caller's transaction (docs/specs/ESPACE_STRUCTURE.md §13.1)."""
    return {
        membership_id: (user_id, role)
        for membership_id, user_id, role in _organisation_memberships(
            organisation_id=organisation_id
        ).values_list("id", "user_id", "role")
    }


def has_current_read_grant(
    *, user_id: UUID, organisation_id: UUID, issuer: str, realm: str
) -> bool:
    return (
        _current_memberships(user_id=user_id, organisation_id=organisation_id)
        .filter(
            organisation__deleted_at__isnull=True,
            organisation__state__in=[Organisation.State.ACTIVE, Organisation.State.SUSPENDED],
            organisation__issuer=issuer,
            organisation__realm=realm,
        )
        .exists()
    )


def active_membership_id(*, user_id: UUID, organisation_id: UUID) -> UUID | None:
    """The current membership's id in an active, undeleted organisation, or None.

    Holds on its own: the same current-membership predicate as
    `has_current_read_grant`, narrowed to active organisations. A removed,
    suspended or invited membership never yields an id, whatever the caller pairs
    it with.
    """
    return (
        _current_memberships(user_id=user_id, organisation_id=organisation_id)
        .filter(
            organisation__state=Organisation.State.ACTIVE,
            organisation__deleted_at__isnull=True,
        )
        .values_list("id", flat=True)
        .first()
    )


def current_membership(*, user_id: UUID, organisation_id: UUID) -> tuple[UUID, str] | None:
    """The current membership's id and stored role, or None: the same current-membership
    predicate as `has_current_read_grant`, which the caller checks for the organisation."""
    found = (
        _current_memberships(user_id=user_id, organisation_id=organisation_id)
        .values_list("id", "role")
        .first()
    )
    return None if found is None else (found[0], found[1])


def organisation_slug(*, organisation_id: UUID) -> str:
    """The slug an audit target names the organisation by (AUDIT_TAXONOMY.md)."""
    return Organisation.objects.values_list("slug", flat=True).get(id=organisation_id)


def visible_organisation_ids(*, organisation_ids: tuple[UUID, ...]) -> frozenset[UUID]:
    return frozenset(
        Organisation.objects.filter(
            id__in=organisation_ids,
            deleted_at__isnull=True,
        ).values_list("id", flat=True)
    )


def person_memberships(*, user_id: UUID) -> tuple[MembershipSnapshot, ...]:
    """Description-only FK projection exception; each current grant is checked separately."""
    values = []
    for membership in (
        Membership.objects.select_related("organisation")
        .filter(
            user_id=user_id,
            deleted_at__isnull=True,
            organisation__deleted_at__isnull=True,
        )
        .order_by("id")
    ):
        organisation = membership.organisation
        values.append(
            MembershipSnapshot(
                membership.id,
                OrganisationSnapshot(
                    organisation.id, organisation.slug, organisation.name, organisation.realm
                ),
                membership.role,
                membership.state,
                membership.accepted_at,
            )
        )
    return tuple(values)


def collection_person_is_current(*, membership_id: UUID, organisation_id: UUID) -> bool:
    """An accepted active person value in the collection's organisation."""
    return Membership.objects.filter(
        pk=membership_id,
        organisation_id=organisation_id,
        state="active",
        accepted_at__isnull=False,
        deleted_at__isnull=True,
        user__enabled=True,
        user__deleted_at__isnull=True,
    ).exists()


@dataclass(frozen=True, slots=True, repr=False)
class MembershipContact:
    id: UUID
    user_id: UUID
    organisation_id: UUID
    email: str
    organisation_name: str


def lock_organisation(*, organisation_id: UUID) -> bool:
    """Hold the organisation fence until the caller's outer transaction ends."""
    return Organisation.objects.select_for_update().filter(id=organisation_id).first() is not None


def lock_membership_user(*, membership_id: UUID) -> UUID:
    """Lock the membership and its joined user, retaining the original lock set."""
    row = Membership.objects.select_for_update().select_related("user").get(id=membership_id)
    return row.user_id


def active_organisation(*, organisation_id: UUID) -> bool:
    return Organisation.objects.filter(
        id=organisation_id, state="active", deleted_at__isnull=True
    ).exists()


def installation_admin_user(*, membership_id: UUID, organisation_id: UUID) -> UUID | None:
    """Current accepted installer authority, scoped to the installation's organisation."""
    return (
        Membership.objects.filter(
            id=membership_id,
            organisation_id=organisation_id,
            state="active",
            role__in=("org_owner", "org_admin"),
            accepted_at__isnull=False,
            deleted_at__isnull=True,
            user__enabled=True,
            user__deleted_at__isnull=True,
        )
        .values_list("user_id", flat=True)
        .first()
    )


def digest_member(*, membership_id: UUID) -> MembershipContact | None:
    row = (
        Membership.objects.filter(
            id=membership_id,
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
    if row is None:
        return None
    return MembershipContact(
        row.id, row.user_id, row.organisation_id, row.user.email, row.organisation.name
    )


@dataclass(frozen=True, slots=True, repr=False)
class PassportMembershipRow:
    membership_id: UUID
    organisation_id: UUID
    organisation_slug: str
    organisation_name: str
    realm: str
    issuer: str
    role: str


def passport_memberships(*, user_id: UUID) -> tuple[PassportMembershipRow, ...]:
    """Eligible active memberships of a person across organisations (one realm per organisation)."""
    rows = (
        Membership.objects.select_related("organisation")
        .filter(
            user_id=user_id,
            deleted_at__isnull=True,
            state=Membership.State.ACTIVE,
            accepted_at__isnull=False,
            role__in=Membership.Role.values,
            user__enabled=True,
            user__deleted_at__isnull=True,
            organisation__state=Organisation.State.ACTIVE,
            organisation__deleted_at__isnull=True,
        )
        .order_by("organisation__slug", "id")
    )
    return tuple(
        PassportMembershipRow(
            membership_id=row.id,
            organisation_id=row.organisation_id,
            organisation_slug=row.organisation.slug,
            organisation_name=row.organisation.name,
            realm=row.organisation.realm,
            issuer=row.organisation.issuer,
            role=row.role,
        )
        for row in rows
    )


def organisation_slug_or_none(*, organisation_id: UUID) -> str | None:
    """Return an undeleted organisation's slug for internal audit target naming, or None."""
    return (
        Organisation.objects.filter(id=organisation_id, deleted_at__isnull=True)
        .values_list("slug", flat=True)
        .first()
    )
