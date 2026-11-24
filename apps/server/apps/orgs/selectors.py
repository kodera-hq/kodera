"""Current customer grant and the explicit authenticated-person switcher projection."""

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from django.db import connection
from django.db.models import Q, QuerySet

from apps.identity.selectors import lock_user_fence, person_identities

from .models import Membership, Organisation


@dataclass(frozen=True, slots=True, repr=False)
class OrganisationSnapshot:
    id: UUID
    slug: str
    name: str
    realm: str
    shared_realm: bool = False
    plan_tier: str = "sovereign"


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
                    organisation.id,
                    organisation.slug,
                    organisation.name,
                    organisation.realm,
                    organisation.shared_realm,
                    organisation.plan_tier,
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


def active_membership_ids_by_user(*, organisation_id: UUID) -> dict[UUID, UUID]:
    """Accepted active memberships of enabled people for read-only import matching."""
    return dict(
        _organisation_memberships(organisation_id=organisation_id)
        .filter(user__enabled=True, user__deleted_at__isnull=True)
        .values_list("user_id", "id")
    )


def current_admin_role(*, membership_id: UUID, organisation_id: UUID) -> str | None:
    return (
        _organisation_memberships(organisation_id=organisation_id)
        .filter(id=membership_id, role__in=("org_owner", "org_admin"))
        .values_list("role", flat=True)
        .first()
    )


def organisation_authority_revision(*, organisation_id: UUID) -> int:
    return Organisation.objects.values_list("authority_revision", flat=True).get(id=organisation_id)


def person_has_membership(*, user_id: UUID, organisation_id: UUID | None = None) -> bool:
    """Guest admission cannot also carry ordinary workspace membership in the target organisation."""
    qs = Membership.objects.filter(user_id=user_id).exclude(state="removed")
    if organisation_id is not None:
        qs = qs.filter(organisation_id=organisation_id)
    return qs.exists()


def has_privacy_cutoff(*, organisation_id: UUID, user_id: UUID | None = None) -> bool:
    """Current durable cutoff existence, including the interval before physical erasure."""
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT EXISTS(SELECT 1 FROM orgs_privacyerasure WHERE organisation_reference=%s) OR EXISTS(SELECT 1 FROM orgs_accounterasure WHERE user_reference=%s)",
            [organisation_id, user_id],
        )
        return bool(cursor.fetchone()[0])


def privacy_cutoff_reason(*, organisation_id: UUID, user_id: UUID | None = None) -> str | None:
    """Return the exact durable GDPR cutoff reason (`organisation_erasure_cutoff` or `account_erasure_cutoff`), or None."""
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT EXISTS(SELECT 1 FROM orgs_privacyerasure WHERE organisation_reference=%s), "
            "EXISTS(SELECT 1 FROM orgs_accounterasure WHERE user_reference=%s)",
            [organisation_id, user_id],
        )
        org_erased, account_erased = cursor.fetchone()
    if org_erased:
        return "organisation_erasure_cutoff"
    if user_id is not None and account_erased:
        return "account_erasure_cutoff"
    return None


def membership_delivery_state(
    *, membership_id: UUID, organisation_id: UUID
) -> tuple[UUID, str, str, datetime | None, datetime | None] | None:
    """Read `(user_id, role, state, accepted_at, deleted_at)` for delivery-time revalidation."""
    row = (
        Membership.objects.filter(id=membership_id, organisation_id=organisation_id)
        .values_list("user_id", "role", "state", "accepted_at", "deleted_at")
        .first()
    )
    if row is None:
        return None
    return (row[0], row[1], row[2], row[3], row[4])


def organisation_delivery_state(*, organisation_id: UUID) -> tuple[str, int] | None:
    """Read `(state, authority_revision)` for delivery-time revalidation."""
    row = (
        Organisation.objects.filter(id=organisation_id, deleted_at__isnull=True)
        .values_list("state", "authority_revision")
        .first()
    )
    if row is None:
        return None
    return (row[0], int(row[1]))


def organisation_is_default_community(*, organisation_id: UUID) -> bool:
    """Only the operator-bound default Community organisation owns the local server."""
    return Organisation.objects.filter(id=organisation_id, is_default_community=True).exists()


def organisation_security_contacts(*, organisation_id: UUID) -> tuple[str | None, str | None]:
    """Return `(security_contact_email, privacy_contact_email)` for `organisation_id`."""
    row = (
        Organisation.objects.filter(id=organisation_id, deleted_at__isnull=True)
        .values_list("security_contact_email", "privacy_contact_email")
        .first()
    )
    if row is None:
        return (None, None)
    return (row[0], row[1])


def ensure_security_and_privacy_contacts(
    *, organisation_id: UUID, fallback_email: str | None = None
) -> bool:
    """Populate missing security/privacy contacts from the active owner's deliverable address."""
    from django.utils import timezone

    from apps.identity.selectors import person_contacts

    from .notice_contacts import deliverable

    row = (
        Organisation.objects.select_for_update(no_key=True)
        .filter(id=organisation_id, deleted_at__isnull=True)
        .values_list("security_contact_email", "privacy_contact_email")
        .first()
    )
    if row is None:
        return False
    sec_email, priv_email = row
    if sec_email and priv_email:
        return False

    candidate: str | None = None
    owner_user_ids = tuple(
        _organisation_memberships(organisation_id=organisation_id)
        .filter(
            role=Membership.Role.OWNER,
            user__enabled=True,
            user__deleted_at__isnull=True,
        )
        .order_by("id")
        .values_list("user_id", flat=True)[:20]
    )
    if owner_user_ids:
        contacts = {p.id: p.email for p in person_contacts(user_ids=owner_user_ids)}
        for uid in owner_user_ids:
            addr = contacts.get(uid)
            if isinstance(addr, str) and deliverable(addr):
                candidate = addr
                break
    if candidate is None and isinstance(fallback_email, str) and deliverable(fallback_email):
        candidate = fallback_email
    if candidate is None:
        return False

    updates: dict[str, object] = {"updated_at": timezone.now()}
    if not sec_email:
        updates["security_contact_email"] = candidate
    if not priv_email:
        updates["privacy_contact_email"] = candidate
    Organisation.objects.filter(id=organisation_id).update(**updates)
    return True


def is_shared_realm_organisation(*, organisation_id: UUID, issuer: str) -> bool:
    """Whether `organisation_id` is an undeleted `shared_realm=True` organisation on `issuer`."""
    return Organisation.objects.filter(
        id=organisation_id,
        shared_realm=True,
        issuer=issuer,
        deleted_at__isnull=True,
    ).exists()


def is_community_or_shared_realm_organisation(
    *, organisation_id: UUID, issuer: str, community_slug: str
) -> bool:
    """Single-query check whether `organisation_id` is canonical community or `shared_realm=True`."""
    cond = Q(shared_realm=True)
    if community_slug:
        cond |= Q(is_default_community=True, slug=community_slug, state="active")
    return (
        Organisation.objects.filter(
            id=organisation_id,
            issuer=issuer,
            deleted_at__isnull=True,
        )
        .filter(cond)
        .exists()
    )


def organisation_plan_tier_state(*, organisation_id: UUID) -> tuple[bool, str, bool] | None:
    """Return `(shared_realm, plan_tier, is_default_community)` for `organisation_id`, or None."""
    row = (
        Organisation.objects.filter(id=organisation_id)
        .values_list("shared_realm", "plan_tier", "is_default_community")
        .first()
    )
    if row is None:
        return None
    return (bool(row[0]), str(row[1]), bool(row[2]))


def set_organisation_plan_tier(*, organisation_id: UUID, plan_tier: str) -> None:
    """Update `Organisation.plan_tier` inside the caller's settlement transaction."""
    Organisation.objects.filter(id=organisation_id).update(plan_tier=plan_tier)


def count_active_freemium_owned_organisations(*, user_id: UUID) -> int:
    """Count active `freemium_pme` organisations currently owned by `user_id`."""
    return Membership.objects.filter(
        user_id=user_id,
        role=Membership.Role.OWNER,
        state=Membership.State.ACTIVE,
        deleted_at__isnull=True,
        organisation__plan_tier=Organisation.PlanTier.FREEMIUM_PME,
        organisation__state=Organisation.State.ACTIVE,
        organisation__deleted_at__isnull=True,
    ).count()


def shared_realm_host_organisation_id(*, organisation_id: UUID) -> UUID | None:
    """If `organisation_id` is an undeleted `shared_realm=True` org, return its shared host
    (`is_default_community=True`) organisation ID on the same realm, else `None`."""
    realm = (
        Organisation.objects.filter(
            id=organisation_id,
            shared_realm=True,
            deleted_at__isnull=True,
        )
        .values_list("realm", flat=True)
        .first()
    )
    if not realm:
        return None
    host_id: UUID | None = (
        Organisation.objects.filter(
            is_default_community=True,
            realm=realm,
            deleted_at__isnull=True,
        )
        .order_by("id")
        .values_list("id", flat=True)
        .first()
    )
    return host_id


def shared_realm_organisation_ids_for_community(
    *, community_organisation_id: UUID, limit: int = 500
) -> tuple[UUID, ...]:
    """If `community_organisation_id` is `is_default_community=True`, return active
    `shared_realm=True` organisation IDs sharing its `realm` (bounded and deterministic)."""
    realm = (
        Organisation.objects.filter(
            id=community_organisation_id,
            is_default_community=True,
            deleted_at__isnull=True,
        )
        .values_list("realm", flat=True)
        .first()
    )
    if not realm:
        return ()
    return tuple(
        Organisation.objects.filter(
            shared_realm=True,
            realm=realm,
            state="active",
            deleted_at__isnull=True,
        )
        .order_by("id")
        .values_list("id", flat=True)[:limit]
    )


def all_shared_realm_organisation_ids_for_community(
    *, community_organisation_id: UUID, limit: int = 10_000
) -> tuple[UUID, ...]:
    """If `community_organisation_id` is `is_default_community=True`, return all
    `shared_realm=True` organisation IDs on its `realm` (active, suspended, or soft-deleted) so
    known subjects of departed or suspended PME organisations remain tracked on the shared host."""
    realm = (
        Organisation.objects.filter(
            id=community_organisation_id,
            is_default_community=True,
            deleted_at__isnull=True,
        )
        .values_list("realm", flat=True)
        .first()
    )
    if not realm:
        return ()
    return tuple(
        Organisation.objects.filter(
            shared_realm=True,
            realm=realm,
        )
        .order_by("id")
        .values_list("id", flat=True)[:limit]
    )


def active_org_member_pairs(*, organisation_ids: tuple[UUID, ...]) -> set[tuple[UUID, UUID]]:
    """Return `(organisation_id, user_id)` pairs holding active memberships in active,
    undeleted organisations among `organisation_ids`."""
    if not organisation_ids:
        return set()
    return {
        (org_id, user_id)
        for org_id, user_id in Membership.objects.filter(
            organisation_id__in=organisation_ids,
            state="active",
            deleted_at__isnull=True,
            user__deleted_at__isnull=True,
            organisation__state="active",
            organisation__deleted_at__isnull=True,
        ).values_list("organisation_id", "user_id")
    }


def is_default_community_organisation(*, organisation_id: UUID) -> bool:
    """Whether `organisation_id` is the undeleted canonical default community organisation."""
    return Organisation.objects.filter(
        id=organisation_id,
        is_default_community=True,
        deleted_at__isnull=True,
    ).exists()


def orgs_under_privacy_erasure_cutoff(*, organisation_ids: tuple[UUID, ...]) -> set[UUID]:
    """Return any organisation IDs among `organisation_ids` frozen by `PrivacyErasure`."""
    if not organisation_ids:
        return set()
    from .models import PrivacyErasure

    return set(
        PrivacyErasure.objects.filter(organisation_reference__in=organisation_ids).values_list(
            "organisation_reference", flat=True
        )
    )
