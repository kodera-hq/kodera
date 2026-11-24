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
GET_WORKSPACE_SECURITY_POSTURE = Operation(
    method="GET", operation_id="getWorkspaceSecurityPosture", scope="workspace:read"
)
REMEDIATE_WORKSPACE_SECURITY_POSTURE = Operation(
    method="POST", operation_id="remediateWorkspaceSecurityPosture", scope="workspace:act"
)
LIST_WORKSPACE_CUSTOM_EMOJIS = Operation(
    method="GET", operation_id="listWorkspaceCustomEmojis", scope="workspace:read"
)
CREATE_WORKSPACE_CUSTOM_EMOJI = Operation(
    method="POST", operation_id="createWorkspaceCustomEmoji", scope="workspace:create"
)
DELETE_WORKSPACE_CUSTOM_EMOJI = Operation(
    method="DELETE", operation_id="deleteWorkspaceCustomEmoji", scope="workspace:delete"
)
GET_WORKSPACE_CUSTOM_EMOJI_BLOB = Operation(
    method="GET", operation_id="getWorkspaceCustomEmojiBlob", scope="workspace:read"
)
LIST_SCHEDULED_MESSAGES = Operation(
    method="GET", operation_id="listScheduledMessages", scope="workspace:read"
)
CREATE_SCHEDULED_MESSAGE = Operation(
    method="POST", operation_id="createScheduledMessage", scope="workspace:create"
)
UPDATE_SCHEDULED_MESSAGE = Operation(
    method="PATCH", operation_id="updateScheduledMessage", scope="workspace:update"
)
CANCEL_SCHEDULED_MESSAGE = Operation(
    method="DELETE", operation_id="cancelScheduledMessage", scope="workspace:delete"
)
LIST_PERSONAL_REMINDERS = Operation(
    method="GET", operation_id="listPersonalReminders", scope="workspace:read"
)
CREATE_PERSONAL_REMINDER = Operation(
    method="POST", operation_id="createPersonalReminder", scope="workspace:create"
)
UPDATE_PERSONAL_REMINDER = Operation(
    method="PATCH", operation_id="updatePersonalReminder", scope="workspace:update"
)
DELETE_PERSONAL_REMINDER = Operation(
    method="DELETE", operation_id="deletePersonalReminder", scope="workspace:delete"
)
GET_MY_WORKSPACE_PREFERENCES = Operation(
    method="GET", operation_id="getMyWorkspacePreferences", scope="workspace:read"
)
UPDATE_MY_WORKSPACE_PREFERENCES = Operation(
    method="PATCH", operation_id="updateMyWorkspacePreferences", scope="workspace:update"
)
