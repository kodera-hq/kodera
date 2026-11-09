"""A support ticket a customer opened: contracts/core-api.openapi.yaml `SupportTicket`, and
docs/specs/SUPPORT_TICKETS.md.

The tenant context is a copy taken when the ticket was opened, never the request's. The address
support replies to is the requester's as Core stored it then. `mail_enqueued_at` is null until the
operator's run hands the ticket's mail to the outbox, and `mail_refused_at` is set instead when the
outbox refuses that mail.
"""

from django.db import models
from django.db.models import Q

from core.db.models import StoredModel

CATEGORIES = ("calls", "documents", "login", "domain", "billing", "capacity", "security", "other")
SEVERITIES = ("question", "degraded", "blocked", "outage")
STATES = ("open", "pending_customer", "pending_kodera", "solved", "closed")
LOCALES = ("fr", "en")
SUBJECT_LENGTH = (3, 200)
BODY_LENGTH = (10, 20_000)


class SupportTicket(StoredModel):
    organisation = models.ForeignKey(
        "orgs.Organisation", on_delete=models.RESTRICT, related_name="+"
    )
    created_by = models.ForeignKey("identity.Identity", on_delete=models.RESTRICT, related_name="+")
    tenant = models.ForeignKey(
        "tenancy.Tenant", on_delete=models.RESTRICT, related_name="+", null=True, blank=True
    )
    subject = models.TextField()
    body = models.TextField()
    category = models.TextField()
    severity = models.TextField()
    state = models.TextField(default="open")
    locale = models.TextField()
    reply_to_email = models.TextField(null=True, blank=True)  # noqa: DJ001 - no address known
    contact_email = models.TextField(null=True, blank=True)  # noqa: DJ001 - the contract's null
    tenant_slug = models.TextField(null=True, blank=True)  # noqa: DJ001 - the contract's null
    tenant_status = models.TextField(null=True, blank=True)  # noqa: DJ001 - the contract's null
    pack_code = models.TextField(null=True, blank=True)  # noqa: DJ001 - the contract's null
    capacity_tier_code = models.TextField(null=True, blank=True)  # noqa: DJ001 - the contract's null
    mail_enqueued_at = models.DateTimeField(null=True, blank=True)
    # Set when the outbox refused the ticket's message: the run stops retrying it, so one ticket
    # that can never be mailed holds back no other (SUPPORT_TICKETS.md §6).
    mail_refused_at = models.DateTimeField(null=True, blank=True)
    # The outbox delivery of the ticket's current message, until it ends (SUPPORT_TICKETS.md §6).
    mail_delivery_id = models.UUIDField(null=True, blank=True)
    mail_delivered_at = models.DateTimeField(null=True, blank=True)
    # Set when a failed or expired message was replaced: a ticket is mailed again once, never more.
    mail_retried_at = models.DateTimeField(null=True, blank=True)
    # Core keeps the customer's text only until its mail is delivered, or RETENTION at most: then
    # subject and body are emptied and both addresses nulled (MODEL.md, SupportTicketLink departure).
    content_erased_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                name="support_ticket_category_valid", condition=Q(category__in=CATEGORIES)
            ),
            models.CheckConstraint(
                name="support_ticket_severity_valid", condition=Q(severity__in=SEVERITIES)
            ),
            models.CheckConstraint(
                name="support_ticket_state_valid", condition=Q(state__in=STATES)
            ),
            models.CheckConstraint(
                name="support_ticket_locale_valid", condition=Q(locale__in=LOCALES)
            ),
            models.CheckConstraint(
                name="support_ticket_subject_valid",
                condition=Q(content_erased_at__isnull=False)
                | Q(subject__length__range=SUBJECT_LENGTH),
            ),
            models.CheckConstraint(
                name="support_ticket_body_valid",
                condition=Q(content_erased_at__isnull=False) | Q(body__length__range=BODY_LENGTH),
            ),
            models.CheckConstraint(
                name="support_ticket_content_erased",
                condition=Q(content_erased_at__isnull=True)
                | Q(subject="", body="", reply_to_email__isnull=True, contact_email__isnull=True),
            ),
        ]
        indexes = [
            # The two limits count an hour of one organisation's, or one identity's, tickets.
            models.Index(fields=["organisation", "created_at"], name="support_ticket_org_recent"),
            models.Index(fields=["created_by", "created_at"], name="support_ticket_by_recent"),
            # The operator's run reads the tickets whose mail is owed.
            models.Index(
                fields=["id"],
                name="support_ticket_mail_owed",
                condition=Q(
                    content_erased_at__isnull=True,
                    mail_enqueued_at__isnull=True,
                    mail_refused_at__isnull=True,
                ),
            ),
            # Its runs settle the tickets whose message is in the outbox, and erase the text of the
            # tickets older than RETENTION.
            models.Index(
                fields=["id"],
                name="support_ticket_mail_unsettled",
                condition=Q(mail_delivery_id__isnull=False),
            ),
            models.Index(
                fields=["created_at"],
                name="support_ticket_content_held",
                condition=Q(content_erased_at__isnull=True),
            ),
        ]

    def __str__(self) -> str:
        return f"support ticket {self.id} {self.state}"
