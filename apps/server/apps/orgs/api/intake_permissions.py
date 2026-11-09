"""The staff intake's declared operation; the staff grant it needs is read by the service."""

from core.api.scopes import Operation

CREATE_ORGANISATION = Operation(
    method="POST", operation_id="createOrganisation", scope="organisation:create"
)
