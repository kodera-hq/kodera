"""Scoped inbox, sealed device subscriptions and leased empty-wakeup deliveries."""

from django.db import models

from core.db.models import StoredModel


class Notification(StoredModel):
    organisation = models.ForeignKey("orgs.Organisation", on_delete=models.RESTRICT)
    membership = models.ForeignKey("orgs.Membership", on_delete=models.RESTRICT)
    kind = models.TextField()
    resource_id = models.UUIDField()
    read_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(kind__in=["mention", "invitation", "moderation", "document"]),
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
