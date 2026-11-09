"""The notice contacts' declarations; the owner-only write is enforced by the service."""

from core.api.scopes import Operation

GET_NOTICE_CONTACTS = Operation(
    method="GET", operation_id="getNoticeContacts", scope="organisation:read"
)
PATCH_NOTICE_CONTACTS = Operation(
    method="PATCH", operation_id="patchNoticeContacts", scope="organisation:update"
)
