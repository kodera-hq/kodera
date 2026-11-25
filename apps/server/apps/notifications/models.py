"""Scoped inbox, sealed device subscriptions, foreground presence leases and empty wakeups."""

from datetime import timedelta

from django.db import models

from core.db.models import StoredModel

NOTIFICATION_KINDS = ("mention", "invitation", "moderation", "document", "reminder")
PERSONAL_REMINDER_STATES = (
    "pending",
    "in_flight",
    "fired",
    "snoozed",
    "completed",
    "cancelled",
    "obsolete",
)


class Notification(StoredModel):
    organisation = models.ForeignKey("orgs.Organisation", on_delete=models.RESTRICT)
    membership = models.ForeignKey("orgs.Membership", on_delete=models.RESTRICT)
    kind = models.TextField()
    resource_id = models.UUIDField()
    read_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(kind__in=list(NOTIFICATION_KINDS)),
                name="notification_kind_valid",
            ),
        ]
        indexes = [
            models.Index(fields=["organisation", "membership", "-id"], name="notification_inbox")
        ]


class PushSubscription(StoredModel):
    organisation = models.ForeignKey("orgs.Organisation", on_delete=models.RESTRICT)
    membership = models.ForeignKey("orgs.Membership", on_delete=models.RESTRICT)
    device_id = models.UUIDField()
    platform = models.TextField(default="web")
    version = models.UUIDField()
    endpoint_digest = models.TextField()
    sealed_subscription = models.BinaryField()
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["organisation", "membership", "device_id"],
                name="push_subscription_device_unique",
            ),
            models.UniqueConstraint(
                fields=["organisation", "endpoint_digest"], name="push_subscription_endpoint_unique"
            ),
            models.CheckConstraint(
                condition=models.Q(endpoint_digest__regex=r"^[a-f0-9]{64}$"),
                name="push_endpoint_digest_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(platform__in=["web", "desktop", "ios", "android"]),
                name="push_subscription_platform_valid",
            ),
        ]


class PresenceLease(StoredModel):
    organisation = models.ForeignKey("orgs.Organisation", on_delete=models.RESTRICT)
    membership = models.ForeignKey("orgs.Membership", on_delete=models.RESTRICT)
    device_id = models.UUIDField()
    platform = models.TextField()
    expires_at = models.DateTimeField()

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["organisation", "membership", "device_id"],
                name="presence_lease_device_unique",
            ),
            models.CheckConstraint(
                condition=models.Q(platform__in=["web", "desktop"]),
                name="presence_lease_platform_valid",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(expires_at__gt=models.F("updated_at"))
                    & models.Q(
                        expires_at__lte=models.F("updated_at") + timedelta(seconds=90),
                    )
                ),
                name="presence_lease_ttl_bound",
            ),
        ]
        indexes = [
            models.Index(
                fields=["organisation", "membership", "expires_at"],
                name="presence_lease_active",
            ),
        ]


class PushOutbox(StoredModel):
    subscription = models.ForeignKey(PushSubscription, on_delete=models.RESTRICT)
    subscription_version = models.UUIDField()
    state = models.TextField(default="pending")
    available_at = models.DateTimeField()
    lease_id = models.UUIDField(null=True, blank=True)
    lease_expires_at = models.DateTimeField(null=True, blank=True)
    attempts = models.IntegerField(default=0)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(
                    state__in=["pending", "in_flight", "delivered", "failed", "obsolete"]
                ),
                name="push_outbox_state_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(attempts__gte=0, attempts__lte=10),
                name="push_outbox_attempts_bound",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(
                        state="in_flight", lease_id__isnull=False, lease_expires_at__isnull=False
                    )
                    | (
                        ~models.Q(state="in_flight")
                        & models.Q(lease_id__isnull=True, lease_expires_at__isnull=True)
                    )
                ),
                name="push_outbox_lease_valid",
            ),
        ]
        indexes = [models.Index(fields=["state", "available_at"], name="push_outbox_ready")]


class PersonalReminder(StoredModel):
    """Per-member reminder on a non-confidential message, firing an inbox notification."""

    class State:
        PENDING = "pending"
        IN_FLIGHT = "in_flight"
        FIRED = "fired"
        SNOOZED = "snoozed"
        COMPLETED = "completed"
        CANCELLED = "cancelled"
        OBSOLETE = "obsolete"

    organisation = models.ForeignKey("orgs.Organisation", on_delete=models.RESTRICT)
    membership = models.ForeignKey("orgs.Membership", on_delete=models.RESTRICT)
    channel = models.ForeignKey(
        "workspaces.Channel", on_delete=models.RESTRICT, null=True, blank=True
    )
    room_id = models.TextField(default="", blank=True)
    target_event_id = models.TextField()
    note = models.TextField(default="", blank=True)
    remind_at = models.DateTimeField()
    state = models.TextField(default="pending")
    lease_id = models.UUIDField(null=True, blank=True)
    lease_expires_at = models.DateTimeField(null=True, blank=True)
    notification_id = models.UUIDField(null=True, blank=True)

    class Meta:
        indexes = [
            models.Index(fields=["state", "remind_at"], name="personal_reminder_ready_idx"),
            models.Index(
                fields=["organisation", "membership", "state", "remind_at"],
                name="personal_reminder_member_idx",
            ),
        ]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(channel__isnull=False) | ~models.Q(room_id=""),
                name="personal_reminder_target_scope_present",
            ),
            models.CheckConstraint(
                condition=models.Q(room_id__length__lte=255),
                name="personal_reminder_room_id_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(target_event_id__length__range=(1, 255)),
                name="personal_reminder_event_id_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(note__length__lte=500),
                name="personal_reminder_note_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(state__in=list(PERSONAL_REMINDER_STATES)),
                name="personal_reminder_state_valid",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(
                        state="in_flight",
                        lease_id__isnull=False,
                        lease_expires_at__isnull=False,
                    )
                    | (
                        ~models.Q(state="in_flight")
                        & models.Q(lease_id__isnull=True, lease_expires_at__isnull=True)
                    )
                ),
                name="personal_reminder_lease_valid",
            ),
        ]
