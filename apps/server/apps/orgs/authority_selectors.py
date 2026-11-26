"""Persisted membership facts and revision; no capability or service permission."""

from dataclasses import dataclass
from uuid import UUID

from django.db import connection, transaction
from psycopg import sql

from apps.identity.selectors import (
    current_identities,
    current_identity,
    current_identity_for_organisation,
    is_storable_subject,
)
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


def read_member_authority_in_snapshot(
    *, verified: VerifiedAccessToken, organisation_id: UUID | None = None
) -> MemberAuthorityFacts:
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
    resolved = (
        current_identity_for_organisation(
            organisation_id=organisation_id, issuer=verified.issuer, subject=subject
        )
        if organisation_id is not None
        else current_identity(issuer=verified.issuer, subject=subject)
    )
    if resolved is None:
        raise MemberAuthorityNotFoundError()
    person, identity = resolved
    if not has_current_read_grant(
        user_id=person.id,
        organisation_id=identity.organisation_id,
        issuer=identity.issuer,
        realm=identity.realm,
        audience=verified.audience,
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
            issuer=verified.issuer,
            oidc_audience__in=verified.audience,
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


def resolve_member_authority(
    *, verified: VerifiedAccessToken, organisation_id: UUID | None = None
) -> MemberAuthorityFacts:
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
        return read_member_authority_in_snapshot(verified=verified, organisation_id=organisation_id)


def resolve_all_member_authorities(
    *, verified: VerifiedAccessToken
) -> tuple[tuple[MemberAuthorityFacts, str, bool], ...]:
    """Resolve `(facts, organisation_slug, is_default_community)` for every active membership of
    `(verified.issuer, verified.subject)` in one `REPEATABLE READ READ ONLY` snapshot."""
    if connection.in_atomic_block or not connection.get_autocommit():
        raise RuntimeError("member authority requires its own transaction")
    subject = verified.subject
    if not is_storable_subject(subject):
        raise MemberAuthorityNotFoundError()
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                sql.SQL("SET TRANSACTION ISOLATION LEVEL {} READ ONLY").format(
                    sql.SQL(_SNAPSHOT_ISOLATION)
                )
            )
        candidates = current_identities(issuer=verified.issuer, subject=subject)
        if not candidates:
            raise MemberAuthorityNotFoundError()
        collected: list[tuple[MemberAuthorityFacts, str, bool]] = []
        saw_unavailable = False
        for _person, ident in candidates:
            if ident.organisation_id is None:
                continue
            try:
                facts = read_member_authority_in_snapshot(
                    verified=verified, organisation_id=ident.organisation_id
                )
            except MemberAuthorityNotFoundError:
                continue
            except MemberAuthorityUnavailableError:
                saw_unavailable = True
                continue
            org_meta = (
                Organisation.objects.filter(
                    id=facts.organisation_id,
                    issuer=verified.issuer,
                    oidc_audience__in=verified.audience,
                    deleted_at__isnull=True,
                )
                .values_list("slug", "is_default_community")
                .first()
            )
            if org_meta is None:
                continue
            collected.append((facts, str(org_meta[0]), bool(org_meta[1])))
        if not collected:
            if saw_unavailable:
                raise MemberAuthorityUnavailableError()
            raise MemberAuthorityNotFoundError()
        collected.sort(key=lambda item: (item[2], item[1], str(item[0].organisation_id)))
        return tuple(collected)


def active_organisation_member_ids(*, organisation_id: UUID, user_ids: set[UUID]) -> list[UUID]:
    """Active accepted membership ids for `user_ids` in `organisation_id`."""
    return list(
        Membership.objects.filter(
            organisation_id=organisation_id,
            user_id__in=user_ids,
            state="active",
            accepted_at__isnull=False,
            deleted_at__isnull=True,
        ).values_list("id", flat=True)
    )


def active_organisation_memberships_by_user(
    *, organisation_id: UUID, user_ids: set[UUID]
) -> dict[UUID, UUID]:
    """Map `user_id -> membership_id` for active accepted memberships with a known role."""
    return dict(
        Membership.objects.filter(
            organisation_id=organisation_id,
            user_id__in=user_ids,
            state="active",
            accepted_at__isnull=False,
            deleted_at__isnull=True,
            role__in=Membership.Role.values,
        ).values_list("user_id", "id")
    )


def organisation_issuer_realm(*, organisation_id: UUID) -> tuple[str, str]:
    """Return `(issuer, realm)` for `organisation_id`."""
    row = Organisation.objects.values_list("issuer", "realm").get(id=organisation_id)
    return str(row[0]), str(row[1])


def bump_organisation_authority_revision(*, organisation_id: UUID) -> int:
    """Advance `orgs_organisation.authority_revision` monotonically via its BEFORE UPDATE trigger."""
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE orgs_organisation SET authority_revision = authority_revision "
            "WHERE id = %s RETURNING authority_revision",
            [organisation_id],
        )
        row = cursor.fetchone()
    if row is None or type(row[0]) is not int:
        raise MemberAuthorityUnavailableError()
    return row[0]
