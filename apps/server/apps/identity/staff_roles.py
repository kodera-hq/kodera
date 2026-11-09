"""Staff role grants: the operator path (docs/specs/STAFF_IDENTITY.md §4).

No HTTP operation reaches these functions; the management commands `bootstrap_staff_roles`,
`grant_staff_role` and `revoke_staff_role` are their only callers. Every staff identity has the one
configured staff issuer, `KODERA_STAFF_ISSUER`. A grant and a revocation take two people: the
acting staff identity holds a current `staff_operator` grant and is not the identity it changes.
The one exception is the bootstrap, which grants the first two operators while no grant exists and
never again. Each grant and revocation writes its audit row in its own transaction.
"""

from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from uuid import UUID

from django.apps import apps as registry
from django.conf import settings
from django.db import IntegrityError, OperationalError, connection, transaction
from django.utils import timezone

from .models import STAFF_REALM, STAFF_ROLES, Identity, StaffRole, User
from .selectors import is_storable_subject

OPERATOR = "staff_operator"


class StaffRoleError(Exception):
    """A grant, a revocation or the bootstrap refused; the message says why, and carries no
    subject or address."""


@dataclass(frozen=True, slots=True)
class StaffGrant:
    identity_id: UUID
    role: str
    created: bool  # False: the identity already held a current grant of the role


def configured_staff_issuer() -> str | None:
    """The one staff issuer of these settings, or None."""
    value = getattr(settings, "KODERA_STAFF_ISSUER", None)
    return value if isinstance(value, str) and value else None


def _audit_installed() -> bool:
    return registry.is_installed("apps.audit")


def _audit() -> Callable[..., None]:
    """The audit writer. The audit application is installed by `config.settings.job_queue`, not by
    the API's customer profile, so a command run under that profile is refused before any write."""
    if not _audit_installed():
        raise StaffRoleError(
            "the audit application is not installed: run with --settings config.settings.job_queue"
        )
    from apps.audit.services import record_staff_role_event

    return record_staff_role_event


# A deadlock, a serialisation failure, a lock not available: what a concurrent change of the same
# rows can make PostgreSQL answer. Any other operational error is not this function's to explain.
CONCURRENT_SQLSTATES = frozenset({"40P01", "40001", "55P03"})
CONCURRENT = "a concurrent change refused this; run it again"


@contextmanager
def _refused_if_concurrent() -> Iterator[None]:
    """Turn what a concurrent change makes the database refuse into StaffRoleError. The transaction
    inside has rolled back, so nothing was written; the operator runs the command again."""
    try:
        yield
    except IntegrityError:
        # The checks before every write hold each constraint but the unique keys, which only a
        # concurrent change of the same key can meet.
        raise StaffRoleError(CONCURRENT) from None
    except OperationalError as error:
        if getattr(error.__cause__, "sqlstate", None) not in CONCURRENT_SQLSTATES:
            raise
        raise StaffRoleError(CONCURRENT) from None


def _issuer() -> str:
    issuer = configured_staff_issuer()
    if issuer is None:
        raise StaffRoleError("KODERA_STAFF_ISSUER is not set: no staff role can be granted")
    return issuer


def _check(*, subject: str, role: str) -> None:
    if role not in STAFF_ROLES:
        raise StaffRoleError(f"{role!r} is not a staff role: {', '.join(STAFF_ROLES)}")
    if not is_storable_subject(subject):
        raise StaffRoleError("the subject is not a storable provider subject")


def _staff_identity(*, issuer: str, subject: str, email: str) -> Identity:
    """The enabled staff identity of (issuer, subject), stored with its person first when no
    identity of that key exists. Locked for the rest of the transaction."""
    identity = (
        Identity.objects.select_for_update(of=("self",))
        .select_related("user")
        .filter(issuer=issuer, subject=subject)
        .first()
    )
    if identity is None:
        if not email:
            raise StaffRoleError("a new staff identity needs an email address")
        user = User.objects.create(email=email, enabled=True)
        return Identity.objects.create(
            user=user,
            organisation=None,
            issuer=issuer,
            realm=STAFF_REALM,
            subject=subject,
            email=email,
            enabled=True,
        )
    # A customer identity never has the staff issuer: no organisation's realm is the staff realm.
    if not (
        identity.enabled
        and identity.deleted_at is None
        and identity.user.enabled
        and identity.user.deleted_at is None
    ):
        raise StaffRoleError("the staff identity or its person is disabled")
    return identity


def _acting_operator(*, identity_id: UUID, issuer: str) -> UUID:
    """The acting staff identity, if it is enabled, of an enabled person, and holds a current
    staff_operator grant. Its grant is locked, so a revocation of it waits for this transaction or
    makes it refuse."""
    grant = (
        StaffRole.objects.select_for_update(of=("self",))
        .filter(
            identity_id=identity_id,
            identity__issuer=issuer,
            identity__enabled=True,
            identity__deleted_at__isnull=True,
            identity__user__enabled=True,
            identity__user__deleted_at__isnull=True,
            role=OPERATOR,
            revoked_at__isnull=True,
        )
        .first()
    )
    if grant is None:
        raise StaffRoleError("the acting staff identity holds no current staff_operator grant")
    return grant.identity_id


def grant_staff_role(
    *, acting_identity_id: UUID, subject: str, email: str, role: str
) -> StaffGrant:
    """Grant `role` to the staff identity of `subject`, storing it first if needed. The acting
    identity is a current operator and another identity (the two-person rule); a role already held
    is reported and neither granted again nor audited."""
    _check(subject=subject, role=role)
    issuer = _issuer()
    record = _audit()
    with _refused_if_concurrent(), transaction.atomic():
        actor = _acting_operator(identity_id=acting_identity_id, issuer=issuer)
        grantee = _staff_identity(issuer=issuer, subject=subject, email=email)
        if grantee.id == actor:
            raise StaffRoleError("two-person rule: a staff identity cannot grant itself a role")
        if StaffRole.objects.filter(identity=grantee, role=role, revoked_at__isnull=True).exists():
            return StaffGrant(grantee.id, role, created=False)
        grant = StaffRole.objects.create(identity=grantee, realm=STAFF_REALM, role=role)
        record(
            action="staff_role.granted",
            actor_id=actor,
            identity_id=grantee.id,
            metadata={"role": role, "grant_id": str(grant.id)},
        )
        return StaffGrant(grantee.id, role, created=True)


def revoke_staff_role(*, acting_identity_id: UUID, subject: str, role: str) -> UUID:
    """Revoke the current grant of `role` to the staff identity of `subject`, enabled or not. The
    acting identity is a current operator and another identity (the two-person rule)."""
    _check(subject=subject, role=role)
    issuer = _issuer()
    record = _audit()
    with _refused_if_concurrent(), transaction.atomic():
        actor = _acting_operator(identity_id=acting_identity_id, issuer=issuer)
        grant = (
            StaffRole.objects.select_for_update(of=("self",))
            .filter(
                identity__issuer=issuer,
                identity__subject=subject,
                role=role,
                revoked_at__isnull=True,
            )
            .first()
        )
        if grant is None:
            raise StaffRoleError("the identity holds no current grant of that role")
        if grant.identity_id == actor:
            raise StaffRoleError("two-person rule: a staff identity cannot revoke its own role")
        grant.revoked_at = timezone.now()
        grant.save(update_fields=["revoked_at", "updated_at"])
        record(
            action="staff_role.revoked",
            actor_id=actor,
            identity_id=grant.identity_id,
            metadata={"role": role, "grant_id": str(grant.id)},
        )
        return grant.id


def bootstrap_staff_roles(*, operators: Sequence[tuple[str, str]]) -> tuple[StaffGrant, ...]:
    """Grant staff_operator to exactly two distinct staff identities, given as (subject, email)
    and stored first if needed, in one transaction, audited with the system as actor and the reason
    `bootstrap`. Refused once any staff role grant exists, revoked or not: it runs once, ever."""
    if len(operators) != 2 or len({subject for subject, _ in operators}) != 2:
        raise StaffRoleError("the bootstrap grants staff_operator to exactly two distinct subjects")
    for subject, _ in operators:
        _check(subject=subject, role=OPERATOR)
    issuer = _issuer()
    record = _audit()
    with _refused_if_concurrent(), transaction.atomic():
        # Two bootstraps at once: the second waits here, then finds the first one's grants.
        with connection.cursor() as cursor:
            cursor.execute(f"LOCK TABLE {StaffRole._meta.db_table} IN EXCLUSIVE MODE")
        if StaffRole.objects.exists():
            raise StaffRoleError("the bootstrap is refused: a staff role has been granted before")
        granted = []
        for subject, email in operators:
            identity = _staff_identity(issuer=issuer, subject=subject, email=email)
            grant = StaffRole.objects.create(identity=identity, realm=STAFF_REALM, role=OPERATOR)
            record(
                action="staff_role.granted",
                actor_id=None,
                identity_id=identity.id,
                metadata={"role": OPERATOR, "grant_id": str(grant.id), "reason": "bootstrap"},
            )
            granted.append(StaffGrant(identity.id, OPERATOR, created=True))
        return tuple(granted)
