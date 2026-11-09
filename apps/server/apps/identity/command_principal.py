"""The operator commands' staff principal: docs/specs/FIRST_OWNER_BOOTSTRAP.md §3.7 (PC-1) and
docs/specs/STAFF_IDENTITY.md §5.

A pilot deviation. The operator commands of the invited pilot carry no token, so they cannot reach
`resolve_staff_principal`; `staff_principal_for_command` builds their principal from the id they
were given with `--staff-identity` instead. The identity is asserted by whoever holds the database
credentials, not proven. This module is not in the API image — `.dockerignore` admits no line that
names it, and `tests/test_development_boundary.py` holds that exact — so no request path can reach
it. It ends with the deviation: when the commands carry device-authorisation staff tokens, or are
replaced by staff HTTP operations, and in any case when the identity worker ships or before the
first paying customer.

The principal carries no role. Every command reads the current `staff_operator` grant where it uses
it, and the queue's decisions read it again (`role_missing`, docs/specs/JOB_QUEUE.md §5.4).
"""

from uuid import UUID

from .models import Identity
from .staff import StaffPrincipal, StaffPrincipalError, _principal
from .staff_roles import configured_staff_issuer


def staff_principal_for_command(identity_id: UUID) -> StaffPrincipal:
    """The principal of the stored staff identity `identity_id`, or `StaffPrincipalError`.

    The identity must be enabled and not deleted, of an enabled person not deleted — what
    `current_staff_identity` reads — and its issuer must be exactly the one staff issuer,
    `KODERA_STAFF_ISSUER`. Unset, no identity has it, and every id is refused. An identity has
    the staff issuer only if it has no organisation (STAFF_IDENTITY.md §1), so a customer identity
    is refused by the issuer.
    """
    # A UUID, never a string: the query would coerce a string into one, and a command parses its
    # argument into a UUID first.
    if not isinstance(identity_id, UUID):
        raise StaffPrincipalError()
    issuer = configured_staff_issuer()
    found = (
        Identity.objects.filter(
            id=identity_id,
            issuer=issuer,
            enabled=True,
            deleted_at__isnull=True,
            user__enabled=True,
            user__deleted_at__isnull=True,
        )
        .values_list("id", "issuer")
        .first()
    )
    if found is None:
        raise StaffPrincipalError()
    return _principal(found[0], found[1])
