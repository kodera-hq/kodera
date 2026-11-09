"""Persisted membership facts and revision; no capability or service permission."""

from dataclasses import dataclass
from uuid import UUID

from django.db import connection, transaction
from psycopg import sql

from apps.identity.selectors import current_identity, is_storable_subject
from services.identity.access_tokens import VerifiedAccessToken

from .models import Membership, Organisation
from .selectors import has_current_read_grant

_SNAPSHOT_ISOLATION = "REPEATABLE READ"


class MemberAuthorityNotFoundError(Exception):
    """No current actor within this reader's supported organisation state."""


class MemberAuthorityUnavailableError(Exception):
    """Persisted revision is unavailable; never manufacture a replacement."""


@dataclass(frozen=True, slots=True, repr=False)
class MemberAuthorityFacts:
    organisation_id: UUID
    user_id: UUID
    identity_id: UUID
    issuer: str
    subject: str
    realm: str
    membership_id: UUID
    stored_role: str
    authority_revision: int


def read_member_authority_in_snapshot(*, verified: VerifiedAccessToken) -> MemberAuthorityFacts:
    """Internal composition seam; caller owns the same qualified read snapshot."""
    if not connection.in_atomic_block:
        raise RuntimeError("member authority requires a read-only repeatable-read snapshot")
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT current_setting('transaction_isolation'), current_setting('transaction_read_only')"
        )
        if cursor.fetchone() != (_SNAPSHOT_ISOLATION.lower(), "on"):
            raise RuntimeError("member authority requires a read-only repeatable-read snapshot")
    subject = verified.subject
    if not is_storable_subject(subject):
        raise MemberAuthorityNotFoundError()
    resolved = current_identity(issuer=verified.issuer, subject=subject)
    if resolved is None:
        raise MemberAuthorityNotFoundError()
    person, identity = resolved
    if not has_current_read_grant(
        user_id=person.id,
        organisation_id=identity.organisation_id,
        issuer=identity.issuer,
        realm=identity.realm,
    ):
        raise MemberAuthorityNotFoundError()
    # The existing helper is the sole active/accepted membership predicate. The
    # unique current membership and organisation are read in that same snapshot.
    member = (
        Membership.objects.filter(
            user_id=person.id, organisation_id=identity.organisation_id, deleted_at__isnull=True
        )
        .values_list("id", "role")
        .first()
    )
    organisation = (
        Organisation.objects.filter(
            id=identity.organisation_id,
            issuer=identity.issuer,
            realm=identity.realm,
            deleted_at__isnull=True,
        )
        .values_list("state", "authority_revision")
        .first()
    )
    if member is None or organisation is None or organisation[0] != Organisation.State.ACTIVE:
        raise MemberAuthorityNotFoundError()
    revision = organisation[1]
    if type(revision) is not int or revision <= 0:
        raise MemberAuthorityUnavailableError()
    return MemberAuthorityFacts(
        identity.organisation_id,
        person.id,
        identity.id,
        identity.issuer,
        subject,
        identity.realm,
        member[0],
        member[1],
        revision,
    )


def resolve_member_authority(*, verified: VerifiedAccessToken) -> MemberAuthorityFacts:
    """One materialized snapshot; callers must not cache its facts as permission."""
    if connection.in_atomic_block or not connection.get_autocommit():
        raise RuntimeError("member authority requires its own transaction")
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                sql.SQL("SET TRANSACTION ISOLATION LEVEL {} READ ONLY").format(
                    sql.SQL(_SNAPSHOT_ISOLATION)
                )
            )
        return read_member_authority_in_snapshot(verified=verified)
