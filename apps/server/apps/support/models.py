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


BUG_COMPONENTS = (
    "workspace",
    "messaging",
    "calls",
    "docs",
    "files",
    "auth",
    "billing",
    "settings",
    "confidential",
    "desktop",
    "mobile",
    "other",
)
BUG_DEVICE_CLASSES = (
    "web-desktop",
    "web-mobile",
    "desktop-macos",
    "desktop-linux",
    "desktop-windows",
    "ios",
    "android",
)
BUG_SCREENSHOT_CONTENT_TYPES = ("image/png", "image/webp")
BUG_RATE_TIERS = ("member", "org", "global")
MAX_SCREENSHOT_BYTES = 256 * 1024


class BugReport(StoredModel):
    """Zero-PII in-app diagnostic bug report queued for private GitHub App triage.

    Intentionally carries zero foreign keys to User, Identity, Membership, Organisation, or Tenant,
    and zero email addresses, IP addresses, or organisation/tenant slugs.
    """

    build_id = models.TextField()
    component = models.TextField()
    error_code = models.TextField()
    device_class = models.TextField()
    consent = models.BooleanField(default=False)
    sanitized_note = models.TextField(default="", blank=True)
    screenshot_content_type = models.TextField(null=True, blank=True)  # noqa: DJ001
    screenshot_bytes = models.BinaryField(null=True, blank=True)
    screenshot_sha256 = models.TextField(null=True, blank=True)  # noqa: DJ001
    dedup_fingerprint = models.TextField()
    occurrences = models.PositiveIntegerField(default=1)
    claimed_at = models.DateTimeField(null=True, blank=True, db_default=None)
    claim_token = models.CharField(max_length=64, default="", db_default="", blank=True)
    dispatched_at = models.DateTimeField(null=True, blank=True, db_default=None)
    github_issue_number = models.PositiveIntegerField(null=True, blank=True, db_default=None)
    dispatch_attempts = models.PositiveIntegerField(default=0, db_default=0)
    last_dispatch_error = models.TextField(default="", db_default="", blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                name="support_bugreport_component_valid",
                condition=Q(component__in=BUG_COMPONENTS),
            ),
            models.CheckConstraint(
                name="support_bugreport_device_valid",
                condition=Q(device_class__in=BUG_DEVICE_CLASSES),
            ),
            models.CheckConstraint(
                name="support_bugreport_build_len",
                condition=Q(build_id__length__range=(1, 64)),
            ),
            models.CheckConstraint(
                name="support_bugreport_error_len",
                condition=Q(error_code__length__range=(1, 80)),
            ),
            models.CheckConstraint(
                name="support_bugreport_note_len",
                condition=Q(sanitized_note__length__lte=2048),
            ),
            models.CheckConstraint(
                name="support_bugreport_dedup_len",
                condition=Q(dedup_fingerprint__length=64),
            ),
            models.CheckConstraint(
                name="support_bugreport_occurrences_pos",
                condition=Q(occurrences__gte=1),
            ),
            models.CheckConstraint(
                name="support_bugreport_consent_required",
                condition=Q(consent=True)
                | Q(
                    sanitized_note="",
                    screenshot_content_type__isnull=True,
                    screenshot_bytes__isnull=True,
                    screenshot_sha256__isnull=True,
                ),
            ),
            models.CheckConstraint(
                name="support_bugreport_screenshot_coherent",
                condition=Q(
                    screenshot_content_type__isnull=True,
                    screenshot_bytes__isnull=True,
                    screenshot_sha256__isnull=True,
                )
                | Q(
                    screenshot_content_type__in=BUG_SCREENSHOT_CONTENT_TYPES,
                    screenshot_bytes__isnull=False,
                    screenshot_sha256__length=64,
                ),
            ),
            models.CheckConstraint(
                name="support_bugreport_dispatched_scrubbed",
                condition=Q(dispatched_at__isnull=True)
                | Q(
                    sanitized_note="",
                    screenshot_content_type__isnull=True,
                    screenshot_bytes__isnull=True,
                    screenshot_sha256__isnull=True,
                    claimed_at__isnull=True,
                    claim_token="",
                ),
            ),
        ]
        indexes = [
            models.Index(
                fields=["dedup_fingerprint", "created_at"],
                name="support_bugreport_dedup_24h",
            ),
            models.Index(
                fields=["created_at"],
                condition=Q(dispatched_at__isnull=True),
                name="support_bugreport_undispatched",
            ),
            models.Index(
                fields=["dispatched_at"],
                condition=Q(dispatched_at__isnull=False),
                name="support_bugreport_dispatched",
            ),
        ]

    def __str__(self) -> str:
        return f"bug report {self.id} {self.component}:{self.error_code}"


class BugReportRateEvent(StoredModel):
    """Rolling 1-hour rate-limit event storing only irreversible keyed-HMAC digests."""

    tier = models.TextField()
    bucket_digest = models.TextField()

    class Meta:
        constraints = [
            models.CheckConstraint(
                name="support_bugrate_tier_valid",
                condition=Q(tier__in=BUG_RATE_TIERS),
            ),
            models.CheckConstraint(
                name="support_bugrate_digest_len",
                condition=Q(bucket_digest__length=64),
            ),
        ]
        indexes = [
            models.Index(
                fields=["tier", "bucket_digest", "created_at"],
                name="support_bugrate_window",
            ),
            models.Index(fields=["created_at"], name="support_bugrate_created"),
        ]

    def __str__(self) -> str:
        return f"bug report rate event {self.id} {self.tier}"


class BugReportCircuitState(StoredModel):
    """Worker-owned upstream GitHub triage circuit-breaker state."""

    singleton = models.BooleanField(default=True, unique=True)
    consecutive_failures = models.PositiveIntegerField(default=0)
    opened_until = models.DateTimeField(null=True, blank=True)
    last_failure_at = models.DateTimeField(null=True, blank=True)
    last_error_code = models.TextField(default="", blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                name="support_bugcircuit_singleton",
                condition=Q(singleton=True),
            ),
        ]

    def __str__(self) -> str:
        return f"bug report circuit failures={self.consecutive_failures}"
