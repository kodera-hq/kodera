"""The single declared consume operation and closed route-local authority failures."""

from core.api.scopes import Operation

from ..claim_consumption import (
    ConsumeGuardError as ConsumeGuardError,
    ConsumerUnknownError as ConsumerUnknownError,
    StaffConsumerUnknownError as StaffConsumerUnknownError,
)

CONSUME_OWNER_CLAIM = Operation(
    method="POST", operation_id="consumeOwnerClaim", scope="owner_claim:act"
)


PROBLEMS = {
    "malformed-request": (400, "Malformed request"),
    "forbidden": (403, "Access refused"),
    "not-found": (404, "Not found"),
    "owner-claim-identity-mismatch": (403, "Owner claim belongs to another identity"),
    "owner-claim-contact-unverified": (403, "Owner contact is not verified"),
    "mfa-required": (403, "Second factor required"),
    "owner-claim-expired": (410, "Owner claim expired"),
    "owner-claim-revoked": (410, "Owner claim revoked"),
    "owner-claim-consumed": (409, "Owner claim already consumed"),
    "invalid-state-transition": (409, "State transition refused"),
    "service-unavailable": (503, "Service unavailable"),
}
