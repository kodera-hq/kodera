"""The staff principal: docs/specs/STAFF_IDENTITY.md §5.

Built for requests here by `resolve_staff_principal`, from a verified token of the staff lane
and of the one staff issuer, `KODERA_STAFF_ISSUER`, that proves a second factor, for a stored
staff identity. It carries no role: an operation reads the `StaffRole` grant it needs itself.
FIRST_OWNER_BOOTSTRAP.md PC-1 permits the command-only `staff_principal_for_command` constructor
outside the API image for the invited pilot; it asserts the stored identity rather than a token.
"""

from typing import Any, NoReturn
from uuid import UUID

from services.identity.access_tokens import VerifiedAccessToken

from .selectors import current_staff_identity, is_storable_subject
from .staff_roles import configured_staff_issuer

# AUTHZ.md §3: a staff token without `amr` containing one of these is refused, whatever the realm
# says.
MFA_METHODS = frozenset({"otp", "hwk", "mfa"})


class StaffPrincipalError(Exception):
    """No staff principal for this token. One closed error: the reason is not told to the caller."""

    def __init__(self) -> None:
        super().__init__("staff principal refused")


class StaffPrincipal:
    """A stored staff identity, resolved from a verified staff token. It carries no role: a role is
    a `StaffRole` grant, read where it is used (docs/specs/STAFF_IDENTITY.md §5).

    The token resolver and PC-1's command-only constructor build one. Calling the class raises, and an instance cannot be
    changed, so a principal cannot be assembled from a request or rebound to another identity.
    """

    __slots__ = ("identity_id", "issuer")
    identity_id: UUID
    issuer: str

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        raise TypeError(
            "a StaffPrincipal is built only by resolve_staff_principal or the pilot's "
            "staff_principal_for_command"
        )

    def __setattr__(self, name: str, value: object) -> NoReturn:
        raise AttributeError("a StaffPrincipal is immutable")

    def __delattr__(self, name: str) -> NoReturn:
        raise AttributeError("a StaffPrincipal is immutable")

    def __copy__(self) -> "StaffPrincipal":
        return self

    def __deepcopy__(self, memo: dict[int, object]) -> "StaffPrincipal":
        return self

    def __reduce__(self) -> NoReturn:
        raise TypeError("a StaffPrincipal is not serialised")

    def __eq__(self, other: object) -> bool:
        if type(other) is not StaffPrincipal:
            return NotImplemented
        return (self.identity_id, self.issuer) == (other.identity_id, other.issuer)

    def __hash__(self) -> int:
        return hash((self.identity_id, self.issuer))

    def __repr__(self) -> str:
        return f"StaffPrincipal(identity_id={self.identity_id})"


def _principal(identity_id: UUID, issuer: str) -> StaffPrincipal:
    principal = object.__new__(StaffPrincipal)
    object.__setattr__(principal, "identity_id", identity_id)
    object.__setattr__(principal, "issuer", issuer)
    return principal


def is_staff_principal(value: object) -> bool:
    """Whether `value` has exactly the class the authorized staff constructors build."""
    return type(value) is StaffPrincipal


def resolve_staff_principal(verified: VerifiedAccessToken, lane: str) -> StaffPrincipal:
    """The staff principal of a verified token, or `StaffPrincipalError`.

    `verified` and `lane` are what `verify_configured_token` returned. The token must come from the
    staff lane and from exactly the one staff issuer, prove a second factor in `amr`, and its
    `(iss, sub)` must be an enabled stored staff identity of an enabled person. The token's roles
    are not read.
    """
    # Exactly the verifier's class, which only services.identity.access_tokens produces: a
    # subclass or a look-alike is not a verified token.
    if type(verified) is not VerifiedAccessToken:
        raise StaffPrincipalError()
    if lane != "staff":
        raise StaffPrincipalError()
    if verified.issuer != configured_staff_issuer():
        raise StaffPrincipalError()
    if not MFA_METHODS.intersection(verified.amr or ()):
        raise StaffPrincipalError()
    if not is_storable_subject(verified.subject):
        raise StaffPrincipalError()
    identity = current_staff_identity(issuer=verified.issuer, subject=verified.subject)
    if identity is None:
        raise StaffPrincipalError()
    return _principal(identity.id, identity.issuer)
