"""One coherent, materialized customer read; no write, bootstrap or authority cache."""

from dataclasses import dataclass
from uuid import UUID

from django.db import connection, transaction

from apps.orgs.claim_readiness import database_now
from apps.orgs.selectors import (
    MembershipSnapshot,
    has_current_read_grant,
    person_memberships,
    visible_organisation_ids,
)
from services.identity.access_tokens import (
    RegisteredFactorReason,
    VerifiedAccessToken,
    evaluate_registered_factor,
    observe_registered_factor_reason,
)

from .selectors import IdentitySnapshot, PersonSnapshot, current_identity, person_identities


class UnknownCustomerError(Exception):
    """The verified subject has no eligible persisted person/identity."""


class CustomerReadForbiddenError(Exception):
    """An eligible identity has no current customer read grant."""


@dataclass(frozen=True, slots=True, repr=False)
class CustomerRead:
    person: PersonSnapshot
    identities: tuple[IdentitySnapshot, ...]
    memberships: tuple[MembershipSnapshot, ...]
    current_identity_id: UUID
    mfa_enrolled: bool | None


def read_customer(
    *, verified: VerifiedAccessToken, lane: str, console_client_id: str | None
) -> CustomerRead:
    subject = verified.subject
    if not 1 <= len(subject) <= 255 or not subject.isascii() or "\x00" in subject:
        raise UnknownCustomerError()
    if connection.in_atomic_block:
        # Do not inherit an earlier request snapshot or silently downgrade isolation.
        raise RuntimeError("customer read requires its own transaction")
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        # This is deliberately the first snapshot-acquiring statement.
        resolved = current_identity(issuer=verified.issuer, subject=subject)
        if resolved is None:
            raise UnknownCustomerError()
        person, identity = resolved
        if not has_current_read_grant(
            user_id=person.id,
            organisation_id=identity.organisation_id,
            issuer=identity.issuer,
            realm=identity.realm,
        ):
            raise CustomerReadForbiddenError()
        candidates = person_identities(user_id=person.id)
        visible = visible_organisation_ids(
            organisation_ids=tuple(candidate.organisation_id for candidate in candidates),
        )
        factor = evaluate_registered_factor(
            verified=verified,
            lane=lane,
            console_client_id=console_client_id,
            database_now=database_now(),
        )
        if factor.reason is RegisteredFactorReason.FUTURE_IAT:
            observe_registered_factor_reason(factor.reason)
        return CustomerRead(
            person,
            tuple(candidate for candidate in candidates if candidate.organisation_id in visible),
            person_memberships(user_id=person.id),
            identity.id,
            factor.value,
        )
