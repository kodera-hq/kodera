"""Workspace declarations; the persisted role, membership and policy are enforced by the services."""

from core.api.scopes import Operation

GET_WORKSPACE = Operation(method="GET", operation_id="getWorkspace", scope="workspace:read")
INITIALISE_WORKSPACE = Operation(
    method="POST", operation_id="initialiseWorkspace", scope="workspace:act"
)
# The structure administration (docs/specs/ESPACE_STRUCTURE.md §3).
CREATE_CATEGORY = Operation(method="POST", operation_id="createCategory", scope="workspace:create")
PATCH_CATEGORY = Operation(method="PATCH", operation_id="patchCategory", scope="workspace:update")
DELETE_CATEGORY = Operation(
    method="DELETE", operation_id="deleteCategory", scope="workspace:delete"
)
CREATE_CHANNEL = Operation(method="POST", operation_id="createChannel", scope="workspace:create")
PATCH_CHANNEL = Operation(method="PATCH", operation_id="patchChannel", scope="workspace:update")
ARCHIVE_CHANNEL = Operation(method="POST", operation_id="archiveChannel", scope="workspace:act")
UNARCHIVE_CHANNEL = Operation(method="POST", operation_id="unarchiveChannel", scope="workspace:act")
GET_CHANNEL_ACCESS = Operation(
    method="GET", operation_id="getChannelAccess", scope="workspace:read"
)
PATCH_CHANNEL_ACCESS = Operation(
    method="PATCH", operation_id="patchChannelAccess", scope="workspace:update"
)
GET_WORKSPACE_ADMINISTRATION = Operation(
    method="GET", operation_id="getWorkspaceAdministration", scope="workspace:read"
)
