"""Support declarations; the caller's membership is enforced by apps/support/tickets.py."""

from core.api.scopes import Operation

CREATE_SUPPORT_TICKET = Operation(
    method="POST", operation_id="createSupportTicket", scope="support_ticket:create"
)
