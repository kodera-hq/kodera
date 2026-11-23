"""Contract declarations; owner/admin authority or webhook HMAC is enforced on every request."""

from core.api.scopes import Operation

PREVIEW_WORKSPACE_IMPORT = Operation("POST", "previewWorkspaceImport", "workspace_import:act")
EXECUTE_WORKSPACE_IMPORT = Operation("POST", "executeWorkspaceImport", "workspace_import:create")
LIST_COEXISTENCE_BRIDGES = Operation("GET", "listCoexistenceBridges", "coexistence_bridge:read")
CREATE_COEXISTENCE_BRIDGE = Operation(
    "POST", "createCoexistenceBridge", "coexistence_bridge:create"
)
REVOKE_COEXISTENCE_BRIDGE = Operation(
    "DELETE", "revokeCoexistenceBridge", "coexistence_bridge:delete"
)
RECEIVE_COEXISTENCE_EVENT = Operation("POST", "receiveCoexistenceEvent", "coexistence_bridge:act")
