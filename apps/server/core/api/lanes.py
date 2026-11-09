"""The one lane guard every customer operation applies to a verified token, before it resolves a
customer identity: docs/api/AUTHZ.md §2 step 6.

`identity-unknown` is for customer identities only. The staff issuer is admitted on the staff lane
alone (`config.environment.staff_issuer` refuses to start otherwise), so a token of the staff issuer
arriving on the customer lane can only come from a misconfigured trust. It is refused here as a
verification failure, `401 unauthenticated` with the view's Bearer challenge, which is what every
customer operation answered it before contract 0.28.0, and never reaches a customer resolver that
would answer it `403 identity-unknown`. A staff-lane token passes unchanged to the operation's own
staff rule.
"""

from django.conf import settings

from services.identity.access_tokens import TokenVerificationError, VerifiedAccessToken
from services.identity.trusted_issuers import Lane


def admit(verified: VerifiedAccessToken, lane: Lane) -> tuple[VerifiedAccessToken, Lane]:
    """`(verified, lane)` unchanged, or `TokenVerificationError` for the staff issuer on the
    customer lane."""
    staff_issuer = getattr(settings, "KODERA_STAFF_ISSUER", None)
    if (
        lane == "customer"
        and isinstance(staff_issuer, str)
        and staff_issuer
        and verified.issuer == staff_issuer
    ):
        raise TokenVerificationError()
    return verified, lane
