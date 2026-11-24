"""Materialized identity reads after explicit opt-in canonical membership preparation."""

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from django.conf import settings
from django.db import connection, transaction

from apps.orgs.claim_readiness import database_now
from apps.orgs.selectors import (
    MembershipSnapshot,
    has_current_read_grant,
    person_memberships,
    visible_organisation_ids,
)
from services.identity.access_tokens import (
    COMMUNITY_MFA_METHODS,
    RegisteredFactorReason,
    VerifiedAccessToken,
    evaluate_registered_factor,
    evaluate_staff_community_factor,
    observe_registered_factor_reason,
)

from .selectors import (
    IdentitySnapshot,
    PersonSnapshot,
    current_identities,
    person_identities,
)


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
    *,
    verified: VerifiedAccessToken,
    lane: str,
    console_client_id: str | None,
    community_issuer: str | None = None,
) -> CustomerRead:
    subject = verified.subject
    if not 1 <= len(subject) <= 255 or not subject.isascii() or "\x00" in subject:
        raise UnknownCustomerError()
    if connection.in_atomic_block:
        # Do not inherit an earlier request snapshot or silently downgrade isolation.
        raise RuntimeError("customer read requires its own transaction")
    effective_community_issuer = (
        getattr(settings, "KODERA_DEFAULT_COMMUNITY_ISSUER", None)
        if community_issuer is None
        else community_issuer
    )
    from apps.orgs.community import ensure_community_membership

    ensure_community_membership(verified=verified)
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        # This is deliberately the first snapshot-acquiring statement.
        resolved_all = current_identities(issuer=verified.issuer, subject=subject)
        if not resolved_all:
            raise UnknownCustomerError()
        person = resolved_all[0][0]
        identity: IdentitySnapshot | None = None
        for cand_person, cand_identity in resolved_all:
            if has_current_read_grant(
                user_id=cand_person.id,
                organisation_id=cand_identity.organisation_id,
                issuer=cand_identity.issuer,
                realm=cand_identity.realm,
            ):
                person = cand_person
                identity = cand_identity
                break
        if identity is None:
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
            community_issuer=effective_community_issuer,
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


def read_staff_community(*, verified: VerifiedAccessToken) -> CustomerRead:
    """Staff may see only their canonical membership; disabled deployments do no database work."""
    from apps.orgs.community import community_member, configured_slug, ensure_community_membership

    if not configured_slug():
        raise CustomerReadForbiddenError()
    shared = community_member(verified=verified)
    if shared is None:
        ensure_community_membership(verified=verified)
        shared = community_member(verified=verified)
    if shared is None:
        raise CustomerReadForbiddenError()
    principal, member = shared
    mfa_enrolled = (
        evaluate_staff_community_factor(verified=verified, database_now=database_now())
        if COMMUNITY_MFA_METHODS.intersection(verified.amr or ())
        else None
    )
    return CustomerRead(
        principal.user,
        (
            IdentitySnapshot(
                principal.id,
                member.organisation_id,
                principal.issuer,
                principal.realm,
                principal.subject,
                principal.email,
            ),
        ),
        tuple(
            m
            for m in person_memberships(user_id=principal.user_id)
            if m.organisation.id == member.organisation_id
        ),
        principal.id,
        mfa_enrolled,
    )


def ensure_rehearsal_operator_identity() -> UUID:
    """Return an active `staff_operator` identity ID, provisioning an isolated rehearsal operator if absent."""
    from core.db.ids import new_uuid7

    from .models import STAFF_REALM, Identity, StaffRole, User
    from .selectors import first_enabled_staff_operator_identity_id

    existing = first_enabled_staff_operator_identity_id()
    if existing is not None:
        return existing

    with transaction.atomic():
        existing = first_enabled_staff_operator_identity_id()
        if existing is not None:
            return existing
        op_id = new_uuid7()
        user = User.objects.create(email=f"rehearsal-operator-{op_id}@staff.invalid")
        identity = Identity.objects.create(
            user=user,
            realm=STAFF_REALM,
            issuer="https://rehearsal-operator.kodera.invalid/realms/kodera-staff",
            subject=f"rehearsal-operator-{op_id}",
            email=user.email,
        )
        StaffRole.objects.create(identity=identity, realm=STAFF_REALM, role="staff_operator")
        return UUID(str(identity.id))


def scrub_person_contacts_and_subjects_in_account_context(*, user_id: UUID, now: datetime) -> None:
    """Scrub `identity_user` and `identity_identity` emails and subjects inside active account worker context."""
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE identity_identity "
            "SET email = 'erased:' || id::text, enabled = false, updated_at = %s "
            "WHERE user_id = %s AND (enabled OR email <> 'erased:' || id::text)",
            [now, user_id],
        )
        cursor.execute(
            "UPDATE identity_identity "
            "SET subject = 'erased:' || id::text, updated_at = %s "
            "WHERE user_id = %s AND NOT enabled AND subject <> 'erased:' || id::text",
            [now, user_id],
        )
        cursor.execute(
            "UPDATE identity_user "
            "SET email = 'erased:' || id::text, display_name = NULL, enabled = false, updated_at = %s "
            "WHERE id = %s AND (enabled OR email <> 'erased:' || id::text OR display_name IS NOT NULL)",
            [now, user_id],
        )


def scrub_passport_records_for_user(
    *,
    user_id: UUID,
    email_sha256s: tuple[str, ...] = (),
) -> int:
    """Purge Kodera Passport workspace contexts, magic-link tokens, and outbox bindings for `user_id`."""
    with connection.cursor() as cursor:
        cursor.execute("SELECT to_regclass('public.identity_passportworkspacecontext') IS NOT NULL")
        if not cursor.fetchone()[0]:
            return 0
        cursor.execute(
            "DELETE FROM identity_passportworkspacecontext WHERE user_id = %s",
            [user_id],
        )
        c_ctx = int(cursor.rowcount or 0)
        cursor.execute(
            "DELETE FROM identity_passportmagiclinktoken t "
            "WHERE t.user_id = %s "
            "   OR encode(sha256(convert_to(lower(btrim(t.email_normalized)), 'UTF8')), 'hex') = ANY(%s)",
            [user_id, list(email_sha256s)],
        )
        c_tok = int(cursor.rowcount or 0)
        cursor.execute(
            "DELETE FROM identity_passportratelimitevent "
            "WHERE occurred_at <= clock_timestamp() - interval '10 minutes'"
        )
        cursor.execute(
            "DELETE FROM identity_passportoutboxbinding WHERE user_id = %s",
            [user_id],
        )
        c_bind = int(cursor.rowcount or 0)
    return c_ctx + c_tok + c_bind
