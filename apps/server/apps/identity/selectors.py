"""Person-bound identity reads; no contact-based linking or lazy result escape.

The customer reads see customer identities only. A staff identity, which has no organisation,
is read by the staff readers at the end of this module and by nothing else
(docs/specs/STAFF_IDENTITY.md §3).
"""

from dataclasses import dataclass
from uuid import UUID

from django.db import connection
from django.db.backends.base.base import BaseDatabaseWrapper

from .models import STAFF_REALM, Identity, User


@dataclass(frozen=True, slots=True, repr=False)
class PersonSnapshot:
    id: UUID
    email: str
    display_name: str | None


@dataclass(frozen=True, slots=True, repr=False)
class IdentitySnapshot:
    id: UUID
    organisation_id: UUID
    issuer: str
    realm: str
    subject: str
    email: str


def _snapshot(identity: Identity) -> IdentitySnapshot:
    organisation_id = identity.organisation_id
    if organisation_id is None:
        # The customer reads filter staff identities out; reaching one here is a defect.
        raise ValueError("a staff identity is not a customer identity")
    return IdentitySnapshot(
        identity.id,
        organisation_id,
        identity.issuer,
        identity.realm,
        identity.subject,
        identity.email,
    )


def is_storable_subject(subject: object) -> bool:
    """Whether `subject` could be stored at all, mirroring `identity_subject_valid`.

    The database check is `^[\\x21-\\x7e]{1,255}$`, printable ASCII. A value outside it can
    match no identity, and a NUL byte cannot even be sent as a query parameter, so a reader
    refuses it as an unknown principal before it touches the database.
    """
    return (
        isinstance(subject, str)
        and 1 <= len(subject) <= 255
        and all("\x21" <= character <= "\x7e" for character in subject)
    )


def current_identity(
    *, issuer: str, subject: str
) -> tuple[PersonSnapshot, IdentitySnapshot] | None:
    identity = (
        Identity.objects.select_related("user")
        .filter(
            issuer=issuer,
            subject=subject,
            organisation__isnull=False,
            enabled=True,
            deleted_at__isnull=True,
            user__enabled=True,
            user__deleted_at__isnull=True,
        )
        .first()
    )
    if identity is None:
        return None
    user = identity.user
    return PersonSnapshot(user.id, user.email, user.display_name), _snapshot(identity)


def person_identities(*, user_id: UUID) -> tuple[IdentitySnapshot, ...]:
    return tuple(
        _snapshot(identity)
        for identity in Identity.objects.filter(
            user_id=user_id,
            organisation__isnull=False,
            enabled=True,
            deleted_at__isnull=True,
        ).order_by("id")
    )


def realm_identities(
    *, user_id: UUID, organisation_id: UUID, usable_only: bool = False
) -> tuple[IdentitySnapshot, ...]:
    """The identities of the person in the organisation's realm (MEMBERSHIP_LIFECYCLE.md §6.1.1):
    every one for turning access off, disabled and soft-deleted rows included, since a row keeps
    its realm user; only enabled, undeleted ones for turning it on."""
    rows = Identity.objects.filter(user_id=user_id, organisation_id=organisation_id)
    if usable_only:
        rows = rows.filter(enabled=True, deleted_at__isnull=True)
    return tuple(_snapshot(identity) for identity in rows.order_by("id"))


def realm_subjects(*, organisation_id: UUID) -> tuple[tuple[UUID, str, bool], ...]:
    """Every identity row of the organisation's realm as (user, subject, usable): disabled and
    soft-deleted rows included, since a row keeps its subject; usable is enabled and not deleted.
    Pseudonymous; read by the engine member sets to name every leaver (ADR-0016)."""
    return tuple(
        (user_id, subject, enabled and deleted_at is None)
        for user_id, subject, enabled, deleted_at in Identity.objects.filter(
            organisation_id=organisation_id
        )
        .order_by("id")
        .values_list("user_id", "subject", "enabled", "deleted_at")
    )


def person_contacts(*, user_ids: tuple[UUID, ...]) -> tuple[PersonSnapshot, ...]:
    """Bounded descriptive contacts, including disabled retained people; never authority."""
    if len(user_ids) > 200:
        raise ValueError("contact snapshot exceeds directory page bound")
    return tuple(
        PersonSnapshot(*row)
        for row in User.objects.filter(id__in=user_ids, deleted_at__isnull=True)
        .order_by("id")
        .values_list("id", "email", "display_name")
    )


# ---------------------------------------------------------------------------- staff reads ----


@dataclass(frozen=True, slots=True, repr=False)
class StaffIdentitySnapshot:
    id: UUID
    user_id: UUID
    issuer: str
    subject: str


def current_staff_identity(*, issuer: str, subject: str) -> StaffIdentitySnapshot | None:
    """The enabled staff identity of (issuer, subject), with its enabled person; else None."""
    found = (
        Identity.objects.filter(
            issuer=issuer,
            subject=subject,
            organisation__isnull=True,
            realm=STAFF_REALM,
            enabled=True,
            deleted_at__isnull=True,
            user__enabled=True,
            user__deleted_at__isnull=True,
        )
        .values_list("id", "user_id", "issuer", "subject")
        .first()
    )
    return None if found is None else StaffIdentitySnapshot(*found)


def current_staff_grant(
    *,
    identity_id: UUID,
    role: str,
    any_identity: bool = False,
    any_role: bool = False,
    revoked_counts: bool = False,
    disabled_identity_counts: bool = False,
    deleted_identity_counts: bool = False,
    disabled_person_counts: bool = False,
    deleted_person_counts: bool = False,
    database: BaseDatabaseWrapper | None = None,
    lock_principal: bool = False,
) -> UUID | None:
    """The id of the identity's grant of `role` that is not revoked, of an enabled, not deleted
    staff identity of an enabled, not deleted person, read now and locked `FOR SHARE` until the
    caller's transaction ends; or None. A revocation of that grant waits for the caller, and one
    that committed first, or that holds the row when this read arrives, is seen.

    The keywords are the job queue's mutant switches (docs/specs/JOB_QUEUE.md §9.2), each dropping
    one clause of the read: the queue passes its own flags, and every other caller leaves them
    False.

    The pilot operator's explicit authorization connection may hold the identity and person too,
    while the queue keeps its default connection and transaction rules. Existing callers use the
    default connection and grant-only lock unchanged.
    """
    clauses = ["i.organisation_id IS NULL"]
    parameters: list[UUID | str] = []
    if not any_identity:
        clauses.append("r.identity_id = %s")
        parameters.append(identity_id)
    if not any_role:
        clauses.append("r.role = %s")
        parameters.append(role)
    if not revoked_counts:
        clauses.append("r.revoked_at IS NULL")
    if not disabled_identity_counts:
        clauses.append("i.enabled")
    if not deleted_identity_counts:
        clauses.append("i.deleted_at IS NULL")
    if not disabled_person_counts:
        clauses.append("u.enabled")
    if not deleted_person_counts:
        clauses.append("u.deleted_at IS NULL")
    where = " AND ".join(clauses)  # fixed clauses only; every value is a bound parameter
    locked = "r, i, u" if lock_principal else "r"
    statement = (
        "SELECT r.id FROM identity_staffrole r "  # noqa: S608
        "JOIN identity_identity i ON i.id = r.identity_id "
        f"JOIN identity_user u ON u.id = i.user_id WHERE {where} "
        f"ORDER BY r.id LIMIT 1 FOR SHARE OF {locked}"
    )
    selected = connection if database is None else database
    with selected.cursor() as cursor:
        cursor.execute(statement, parameters)
        found = cursor.fetchone()
    return None if found is None else UUID(str(found[0]))


@dataclass(frozen=True, slots=True, repr=False)
class DeliveryIdentity:
    id: UUID
    user_id: UUID
    organisation_id: UUID | None
    email: str
    issuer: str
    subject: str


def delivery_identity(*, identity_id: UUID) -> DeliveryIdentity | None:
    """An enabled identity; the calling delivery policy binds its person and organisation."""
    row = Identity.objects.filter(id=identity_id, enabled=True, deleted_at__isnull=True).first()
    if row is None:
        return None
    return DeliveryIdentity(
        row.id, row.user_id, row.organisation_id, row.email, row.issuer, row.subject
    )


def delivery_identity_exists(*, user_id: UUID, organisation_id: UUID) -> bool:
    return Identity.objects.filter(
        user_id=user_id, organisation_id=organisation_id, enabled=True, deleted_at__isnull=True
    ).exists()


def lock_delivery_identity(*, identity_id: UUID) -> None:
    """Hold the named identity lock in the caller's transaction."""
    Identity.objects.select_for_update().get(id=identity_id)


def lock_delivery_identities(*, user_id: UUID, organisation_id: UUID) -> None:
    """Evaluate all current rows before returning; no lazy query escapes the lock port."""
    list(
        Identity.objects.select_for_update().filter(
            user_id=user_id, organisation_id=organisation_id
        )
    )
