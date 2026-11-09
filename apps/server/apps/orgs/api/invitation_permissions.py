"""Invitation declarations; the persisted role and grant are enforced by apps/orgs/invitations.py."""

from core.api.scopes import Operation

LIST_INVITATIONS = Operation(method="GET", operation_id="listInvitations", scope="invitation:read")
INVITE_TO_ORGANISATION = Operation(
    method="POST", operation_id="inviteToOrganisation", scope="invitation:create"
)
REVOKE_INVITATION = Operation(
    method="DELETE", operation_id="revokeInvitation", scope="invitation:delete"
)
RESEND_INVITATION = Operation(
    method="POST", operation_id="resendInvitation", scope="invitation:act"
)
ACCEPT_INVITATION = Operation(
    method="POST", operation_id="acceptInvitation", scope="membership:create"
)
PREVIEW_INVITATION = Operation(
    method="POST", operation_id="previewInvitation", scope="invitation:read"
)
