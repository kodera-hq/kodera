"""The contract's named anonymous organisation-read exception."""

from core.api.scopes import Operation

DISCOVER_REALM = Operation(method="POST", operation_id="discoverRealm", scope="organisation:read")
