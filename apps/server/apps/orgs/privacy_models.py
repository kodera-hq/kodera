"""Durable private-export checkpoints; archive contents stay in private expiring storage."""

from django.db import models

from core.db.models import StoredModel


class PrivacyExport(StoredModel):
    identity = models.ForeignKey("identity.Identity", on_delete=models.RESTRICT)
    user = models.ForeignKey("identity.User", on_delete=models.RESTRICT)
    organisation = models.ForeignKey(
        "orgs.Organisation", on_delete=models.RESTRICT, null=True, blank=True
    )
    scope = models.TextField()
    status = models.TextField(default="queued")
    request_snapshot = models.JSONField()
    checkpoint = models.JSONField()
    revision = models.PositiveBigIntegerField(default=1)
    expires_at = models.DateTimeField()

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(scope="account", organisation__isnull=True)
                | models.Q(scope="workspace", organisation__isnull=False),
                name="privacy_export_scope_binding",
            ),
            models.CheckConstraint(
                condition=models.Q(status__in=["queued", "running", "ready", "expired", "failed"]),
                name="privacy_export_status",
            ),
            models.CheckConstraint(
                condition=models.Q(revision__gte=1), name="privacy_export_revision"
            ),
        ]
        indexes = [
            models.Index(fields=["user", "-id"], name="privacy_export_person"),
            models.Index(fields=["status", "expires_at"], name="privacy_export_expiry"),
        ]
