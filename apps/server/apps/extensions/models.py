"""Durable scoped work and consent references; app signing secrets never enter the database."""

from datetime import timedelta

from django.db import models
from django.db.models import F, Q
from django.utils import timezone

from core.db.ids import new_uuid7
from core.db.models import StoredModel


def delivery_expiry():
    return timezone.now() + timedelta(days=7)


class Installation(StoredModel):
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.RESTRICT)
    creator = models.ForeignKey("orgs.Membership", on_delete=models.RESTRICT)
    name = models.TextField()
    endpoint = models.TextField()
    events = models.JSONField()
    generation = models.UUIDField(default=new_uuid7)
    previous_generation = models.UUIDField(null=True)
    grace_expires_at = models.DateTimeField(null=True)
    version = models.UUIDField(default=new_uuid7)
    revoked_at = models.DateTimeField(null=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                name="extension_rotation_fields",
                condition=Q(previous_generation__isnull=True, grace_expires_at__isnull=True)
                | Q(previous_generation__isnull=False, grace_expires_at__isnull=False)
                & ~Q(previous_generation=F("generation")),
            )
        ]


class Delivery(StoredModel):
    installation = models.ForeignKey(Installation, on_delete=models.RESTRICT)
    installation_version = models.UUIDField()
    event_key = models.TextField()
    event = models.BinaryField()
    event_sha256 = models.TextField()
    expires_at = models.DateTimeField(default=delivery_expiry)
    purged_at = models.DateTimeField(null=True)
    state = models.TextField(default="pending")
    attempts = models.IntegerField(default=0)
    available_at = models.DateTimeField()
    lease_id = models.UUIDField(null=True)
    lease_expires_at = models.DateTimeField(null=True)
    response_status = models.IntegerField(null=True)
    outcome = models.TextField(null=True)  # noqa: DJ001 - absent until an attempt

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["installation", "event_key"], name="extension_event_once"
            ),
            models.CheckConstraint(
                name="extension_delivery_state",
                condition=Q(
                    state__in=(
                        "pending",
                        "in_flight",
                        "delivered",
                        "dead_letter",
                        "needs_reconciliation",
                        "obsolete",
                    )
                ),
            ),
            models.CheckConstraint(
                name="extension_delivery_attempts", condition=Q(attempts__gte=0, attempts__lte=8)
            ),
            models.CheckConstraint(
                name="extension_delivery_digest", condition=Q(event_sha256__regex=r"^[a-f0-9]{64}$")
            ),
            models.CheckConstraint(
                name="extension_delivery_lease",
                condition=Q(
                    state="in_flight", lease_id__isnull=False, lease_expires_at__isnull=False
                )
                | ~Q(state="in_flight") & Q(lease_id__isnull=True, lease_expires_at__isnull=True),
            ),
        ]
        indexes = [models.Index(fields=["state", "available_at"], name="extension_due_idx")]


class DeliveryAttempt(StoredModel):
    delivery = models.ForeignKey(Delivery, on_delete=models.RESTRICT)
    number = models.IntegerField()
    lease_id = models.UUIDField()
    outcome = models.TextField(default="started")
    response_status = models.IntegerField(null=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["delivery", "number"], name="extension_attempt_once"),
            models.CheckConstraint(
                name="extension_attempt_outcome",
                condition=Q(
                    outcome__in=(
                        "started",
                        "delivered",
                        "retry",
                        "refused",
                        "uncertain",
                        "obsolete",
                    )
                ),
            ),
        ]


class ImportBatch(StoredModel):
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.RESTRICT)
    creator = models.ForeignKey("orgs.Membership", on_delete=models.RESTRICT)
    source = models.TextField()
    archive_sha256 = models.TextField()
    state = models.TextField(default="pending")
    report = models.JSONField(default=dict)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "source", "archive_sha256"], name="extension_import_once"
            ),
            models.CheckConstraint(
                name="extension_import_source",
                condition=Q(source__in=("slack", "discord", "notion")),
            ),
            models.CheckConstraint(
                name="extension_import_state",
                condition=Q(state__in=("pending", "complete", "partial")),
            ),
        ]


class ImportedObject(StoredModel):
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.RESTRICT)
    source = models.TextField()
    external_key = models.TextField()
    source_sha256 = models.TextField()
    document = models.ForeignKey("docs.Document", on_delete=models.RESTRICT)
    collection = models.ForeignKey("docs.Collection", on_delete=models.RESTRICT, null=True)
    batch = models.ForeignKey(ImportBatch, on_delete=models.RESTRICT)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "source", "external_key"], name="extension_import_object_once"
            )
        ]


class DigestConsent(StoredModel):
    membership = models.OneToOneField("orgs.Membership", on_delete=models.RESTRICT)
    identity = models.ForeignKey("identity.Identity", on_delete=models.RESTRICT)
    version = models.UUIDField(default=new_uuid7)
    enabled = models.BooleanField(default=False)
    locale = models.TextField(default="en")
    consented_at = models.DateTimeField(null=True)
    revoked_at = models.DateTimeField(null=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                name="extension_digest_locale", condition=Q(locale__in=("en", "fr"))
            ),
            models.CheckConstraint(
                name="extension_digest_consent",
                condition=~Q(enabled=True) | Q(consented_at__isnull=False, revoked_at__isnull=True),
            ),
        ]


class DigestJob(StoredModel):
    consent = models.ForeignKey(DigestConsent, on_delete=models.RESTRICT)
    consent_version = models.UUIDField()
    document_ids = models.JSONField(default=list)
    collection_ids = models.JSONField(default=list)
    period_start = models.DateTimeField()
    period_end = models.DateTimeField()
    state = models.TextField(default="pending")
    delivery_id = models.UUIDField(null=True, unique=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["consent", "period_start", "period_end"],
                name="extension_digest_period_once",
            ),
            models.CheckConstraint(
                name="extension_digest_period", condition=Q(period_end__gt=F("period_start"))
            ),
            models.CheckConstraint(
                name="extension_digest_state",
                condition=Q(state__in=("pending", "enqueued", "obsolete")),
            ),
        ]


class DeliveryDecision(StoredModel):
    """An owner/admin's explicit remote-observation decision, never an automatic retry guess."""

    delivery = models.ForeignKey(Delivery, on_delete=models.RESTRICT)
    attempt = models.OneToOneField(DeliveryAttempt, on_delete=models.RESTRICT)
    decided_by = models.ForeignKey("orgs.Membership", on_delete=models.RESTRICT)
    observed = models.TextField()
    evidence_ref = models.TextField()

    class Meta:
        constraints = [
            models.CheckConstraint(
                name="extension_decision_observed",
                condition=Q(observed__in=("applied", "not_applied", "abandon")),
            ),
            models.CheckConstraint(
                name="extension_decision_evidence",
                condition=Q(evidence_ref__regex=r"^urn:kodera:evidence:[0-9a-f-]{36}$"),
            ),
        ]


class WorkspaceCutoff(models.Model):
    """Minimal identifier-only anti-resurrection marker; its organisation identifier is never reused."""

    organisation_id = models.UUIDField(primary_key=True)
    cutoff_at = models.DateTimeField()

    def __str__(self) -> str:
        return f"extension cutoff {self.organisation_id}"
