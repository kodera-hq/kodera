"""Current customer grant and the explicit authenticated-person switcher projection."""

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from django.db import connection
from django.db.models import QuerySet

from apps.identity.selectors import lock_user_fence, person_identities

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


def organisation_exists(*, organisation_id: UUID) -> bool:
    return Organisation.objects.filter(id=organisation_id).exists()


def membership_user_id(*, membership_id: UUID) -> UUID:
    """Resolve a membership's immutable person id without acquiring a row lock."""
    user_id = Membership.objects.values_list("user_id", flat=True).get(id=membership_id)
    return user_id if isinstance(user_id, UUID) else UUID(str(user_id))


def lock_erasure_cutoff_fences(*, organisation_id: UUID, user_id: UUID | None = None) -> None:
    """Acquire shared org/account erasure cutoff advisory fences before any actor or domain row locks."""
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT pg_advisory_xact_lock_shared(hashtextextended('privacy_erasure_cutoff:' || %s, 0))",
            [str(organisation_id)],
        )
        if user_id is not None:
            cursor.execute(
                "SELECT pg_advisory_xact_lock_shared(hashtextextended('privacy_account_cutoff:' || %s, 0))",
                [str(user_id)],
            )


def lock_organisation(*, organisation_id: UUID) -> bool:
    """Hold a non-key organisation fence until the caller's outer transaction ends."""
    return (
        Organisation.objects.select_for_update(no_key=True).filter(id=organisation_id).first()
        is not None
    )


def lock_organisation_fence(*, organisation_id: UUID) -> None:
    """Hold a non-key organisation fence before workspace locks so membership writers serialize."""
    Organisation.objects.select_for_update(no_key=True).filter(id=organisation_id).first()


def lock_membership_fence(*, membership_id: UUID) -> UUID:
    """Hold a shared membership fence before identity, user, organisation, and workspace locks."""
    user_id = lock_membership_fence_if_present(membership_id=membership_id)
    if user_id is None:
        raise Membership.DoesNotExist("Membership matching query does not exist.")
    return user_id


def lock_membership_fence_if_present(*, membership_id: UUID) -> UUID | None:
    """Hold a shared membership fence if the row still exists."""
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT user_id FROM orgs_membership WHERE id = %s FOR SHARE",
            [membership_id],
        )
        row = cursor.fetchone()
    if row is None:
        return None
    return row[0] if isinstance(row[0], UUID) else UUID(str(row[0]))


def lock_membership_user(*, membership_id: UUID) -> UUID:
    """Hold shared fences on the membership and its joined user in canonical m -> u order."""
    user_id = lock_membership_fence(membership_id=membership_id)
    lock_user_fence(user_id=user_id)
    return user_id


def lock_membership_only(*, membership_id: UUID) -> UUID | None:
    """Hold a shared membership fence if the row still exists."""
    return lock_membership_fence_if_present(membership_id=membership_id)


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
        .select_related("user", "organisation")
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
    """Eligible active memberships of a person across organisations (one realm per organisation).

    Requires both an active accepted `Membership` and an enabled, undeleted customer `Identity`
    bound to that target organisation's `(organisation_id, realm, issuer)`.
    """
    active_identities = person_identities(user_id=user_id)
    if not active_identities:
        return ()
    valid_bindings = {
        (ident.organisation_id, ident.realm, ident.issuer) for ident in active_identities
    }
    org_ids = {ident.organisation_id for ident in active_identities}
    rows = (
        Membership.objects.select_related("organisation")
        .filter(
            user_id=user_id,
            organisation_id__in=org_ids,
            deleted_at__isnull=True,
            state=Membership.State.ACTIVE,
            accepted_at__isnull=False,
            role__in=Membership.Role.values,
            user__enabled=True,
            user__deleted_at__isnull=True,
            organisation__state=Organisation.State.ACTIVE,
            organisation__deleted_at__isnull=True,
        )
        .exclude(organisation__realm="kodera-staff")
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
        if (row.organisation_id, row.organisation.realm, row.organisation.issuer) in valid_bindings
    )


def organisation_slug_or_none(*, organisation_id: UUID) -> str | None:
    """Return an undeleted organisation's slug for internal audit target naming, or None."""
    return (
        Organisation.objects.filter(id=organisation_id, deleted_at__isnull=True)
        .values_list("slug", flat=True)
        .first()
    )


def attachment_sweep_organisation_ids(
    *,
    after_org: UUID | None = None,
    include_after_org: bool = False,
    limit: int = 50,
) -> tuple[UUID, ...]:
    """Return undeleted customer organisation IDs ordered by UUID for bounded S3 orphan sweeps."""
    qs = Organisation.objects.filter(deleted_at__isnull=True).exclude(realm="kodera-staff")
    if after_org is not None:
        qs = qs.filter(id__gte=after_org) if include_after_org else qs.filter(id__gt=after_org)
    return tuple(qs.order_by("id").values_list("id", flat=True)[:limit])


def previous_sweep_organisation_id(*, before_org: UUID) -> UUID | None:
    """Return the immediate predecessor undeleted customer organisation ID before `before_org`."""
    return (
        Organisation.objects.filter(deleted_at__isnull=True, id__lt=before_org)
        .exclude(realm="kodera-staff")
        .order_by("-id")
        .values_list("id", flat=True)
        .first()
    )
