"""Customer-only runtime subset; persisted grant policy lives in the service."""

from core.api.scopes import Operation

GET_ORGANISATION = Operation(
    method="GET", operation_id="getOrganisation", scope="organisation:read"
)
