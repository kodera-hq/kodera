"""Scoped support evidence reads for other applications' services."""

from uuid import UUID

from .models import SupportTicket


def open_billing_ticket(*, ticket_id: UUID, organisation_id: UUID) -> bool:
    """A current billing dispute case, including either side's pending state."""
    return SupportTicket.objects.filter(
        id=ticket_id,
        organisation_id=organisation_id,
        category="billing",
        state__in=("open", "pending_customer", "pending_kodera"),
    ).exists()
