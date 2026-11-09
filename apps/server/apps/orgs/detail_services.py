"""Current issuer-bound authorization and data share one read-only snapshot."""

from uuid import UUID

from django.db import connection, transaction

from apps.identity.selectors import current_identity
from services.identity.access_tokens import VerifiedAccessToken

from .detail_selectors import OrganisationDetail, organisation_detail
from .selectors import has_current_read_grant


class UnknownOrganisationCustomerError(Exception):
    """No eligible persisted identity and person for this verified subject."""


class OrganisationReadForbiddenError(Exception):
    """No current customer read grant for this issuer-bound organisation."""


class OrganisationNotFoundError(Exception):
    """The target is outside the verified customer's organisation."""


def read_organisation(*, verified: VerifiedAccessToken, target_id: UUID) -> OrganisationDetail:
    subject = verified.subject
    if not 1 <= len(subject) <= 255 or not subject.isascii() or "\x00" in subject:
        raise UnknownOrganisationCustomerError()
    if connection.in_atomic_block:
        raise RuntimeError("organisation read requires its own transaction")
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        resolved = current_identity(issuer=verified.issuer, subject=subject)
        if resolved is None:
            raise UnknownOrganisationCustomerError()
        person, identity = resolved
        if target_id != identity.organisation_id:
            raise OrganisationNotFoundError()
        if not has_current_read_grant(
            user_id=person.id,
            organisation_id=identity.organisation_id,
            issuer=identity.issuer,
            realm=identity.realm,
        ):
            raise OrganisationReadForbiddenError()
        detail = organisation_detail(
            organisation_id=identity.organisation_id, issuer=identity.issuer, realm=identity.realm
        )
        if detail is None:
            raise OrganisationReadForbiddenError()
        return detail
