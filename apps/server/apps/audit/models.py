"""Audit event record: docs/domain/AUDIT_TAXONOMY.md §1.

The tamper-evidence chain columns (§5) belong to a later item. organisation_id and job_id carry no
foreign key: an audit row outlives what it names. 0002_guards refuses every UPDATE and DELETE.
"""

from django.db import models
from django.db.models import Q

from core.db.functions import ClockTimestamp
from core.db.ids import new_uuid7

ACTOR_TYPES = ("staff", "tenant", "agent", "system")
RETENTION_CLASSES = ("short", "standard")


class AuditEvent(models.Model):
    id = models.UUIDField(primary_key=True, default=new_uuid7, editable=False)
    occurred_at = models.DateTimeField(db_default=ClockTimestamp())
    actor_type = models.TextField()
    actor_id = models.UUIDField(null=True)
    actor_label = models.TextField()
    organisation_id = models.UUIDField(null=True)
    action = models.TextField()
    target_urn = models.TextField()
    before = models.JSONField(null=True)
    after = models.JSONField(null=True)
    request_id = models.TextField(null=True)  # noqa: DJ001 - null when no API request is involved
    job_id = models.UUIDField(null=True)
    source_ip_trunc = models.GenericIPAddressField(null=True)
    retention_class = models.TextField()
    metadata = models.JSONField(
        default=dict, db_default=models.Value({}, output_field=models.JSONField())
    )

    class Meta:
        db_table = "audit_auditevent"
        constraints = [
            models.CheckConstraint(
                name="audit_auditevent_actor_type_valid", condition=Q(actor_type__in=ACTOR_TYPES)
            ),
            models.CheckConstraint(
                name="audit_auditevent_retention_class_valid",
                condition=Q(retention_class__in=RETENTION_CLASSES),
            ),
        ]
        indexes = [
            models.Index(fields=["job_id", "action"], name="audit_auditevent_job_idx"),
            models.Index(
                fields=["organisation_id", "occurred_at", "id"],
                name="audit_auditevent_org_idx",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.action} {self.target_urn}"
