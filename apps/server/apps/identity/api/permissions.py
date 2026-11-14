"""Declared customer-only subset of identity and Kodera Passport operations."""

from core.api.scopes import Operation

SCOPE = "identity:read"
ROLES = ("org_owner", "org_admin", "org_billing", "org_member")
GET_ME = Operation(method="GET", operation_id="getMe", scope=SCOPE)

REQUEST_PASSPORT_MAGIC_LINK = Operation(
    method="POST",
    operation_id="requestPassportMagicLink",
    scope="identity:act",
)
VERIFY_PASSPORT_MAGIC_LINK = Operation(
    method="POST",
    operation_id="verifyPassportMagicLink",
    scope="identity:act",
)
LIST_PASSPORT_WORKSPACES = Operation(
    method="GET",
    operation_id="listPassportWorkspaces",
    scope="identity:read",
)
SWITCH_PASSPORT_WORKSPACE = Operation(
    method="POST",
    operation_id="switchPassportWorkspace",
    scope="identity:act",
)
