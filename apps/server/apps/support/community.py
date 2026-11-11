"""Community support tickets with database-serialized per-person quotas and safe triage."""

from django.db import transaction
from django.utils import timezone

from apps.audit.services import record_support_ticket_opened
from apps.identity.models import User
from apps.orgs.community import community_member
from services.identity.access_tokens import VerifiedAccessToken

from .models import SupportTicket
from .tickets import PER_IDENTITY, WINDOW, TicketInputError, TicketRateLimitedError, TicketRequest
from .triage import classify_support_ticket


class CommunitySupportForbiddenError(Exception):
    pass


@transaction.atomic
def open_community_ticket(
    *, verified: VerifiedAccessToken, request: TicketRequest, request_id: str = "community-support"
) -> dict[str, str]:
    caller = community_member(verified=verified)
    if caller is None:
        raise CommunitySupportForbiddenError()
    principal, member = caller
    # One lock covers every issuer identity of the same persisted person.
    User.objects.select_for_update().get(id=principal.user_id)
    if community_member(verified=verified) is None:
        raise CommunitySupportForbiddenError()
    if (
        request.organisation_id not in (None, member.organisation_id)
        or request.tenant_id is not None
    ):
        raise TicketInputError()
    if (
        SupportTicket.objects.filter(
            created_by__user_id=principal.user_id, created_at__gte=timezone.now() - WINDOW
        ).count()
        >= PER_IDENTITY
    ):
        raise TicketRateLimitedError(int(WINDOW.total_seconds()))
    ticket = SupportTicket.objects.create(
        organisation_id=member.organisation_id,
        created_by=principal,
        subject=request.subject,
        body=request.body,
        category=request.category,
        severity=request.severity,
        locale=request.locale,
        reply_to_email=principal.user.email,
        contact_email=request.contact_email,
    )
    record_support_ticket_opened(
        organisation_id=member.organisation_id,
        ticket_id=ticket.id,
        actor_id=principal.id,
        request_id=request_id,
        category=ticket.category,
        severity=ticket.severity,
    )
    verdict = classify_support_ticket(ticket)
    return {
        "id": str(ticket.id),
        "state": ticket.state,
        "priority": verdict.priority,
        "queue": verdict.queue,
        "confirmation": "ticket-created",
    }
