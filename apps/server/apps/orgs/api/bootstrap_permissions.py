"""Named, current held bootstrap exception; ordinary tenant authorization is unchanged."""

from dataclasses import dataclass
from uuid import UUID

from core.api.scopes import Operation
from services.identity.access_tokens import VerifiedAccessToken

GET_BOOTSTRAP = Operation(
    method="GET", operation_id="getOrganisationBootstrap", scope="organisation_bootstrap:read"
)
BOOTSTRAP_OPERATIONS = frozenset({"getOrganisationBootstrap", "consumeOwnerClaim"})


class BootstrapUnknownIdentityError(Exception):
    """No current persisted identity for the verified customer subject: `403 identity-unknown`."""


class BootstrapStaffUnauthenticatedError(Exception):
    """A staff token, or the staff issuer on another lane, whose subject no staff principal can
    name: `401`, as before. `identity-unknown` is for customer identities only."""


class BootstrapNotFoundError(Exception):
    """The requested bootstrap is outside this bound customer or absent."""


class BootstrapForbiddenError(Exception):
    def __init__(
        self,
        *,
        actor_id: UUID | None = None,
        actor_type: str = "staff",
        reason: str = "role_missing",
    ):
        super().__init__("bootstrap read refused")
        self.actor_id = actor_id
        self.actor_type = actor_type
        self.reason = reason


@dataclass(frozen=True, slots=True)
class BootstrapAuthority:
    identity_id: UUID
    actor_type: str
    grant_id: UUID | None = None


def authorise_bootstrap_operation(
    *, operation_id: str, verified: VerifiedAccessToken, lane: str, target_id: UUID
) -> BootstrapAuthority:
    from ..bootstrap_services import _authorise_bootstrap_operation

    return _authorise_bootstrap_operation(
        operation_id=operation_id, verified=verified, lane=lane, target_id=target_id
    )
