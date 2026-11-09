"""One replay entry per principal, method, path and key: docs/specs/IDEMPOTENCY_REPLAY.md §2.5.

The request body is never stored, only its hash, and the response is stored as the bytes the first
answer sent with the three response headers a replay must repeat. The table has no other column.
"""

from django.db import models
from django.db.models import Q
from django.db.models.functions import Length, Now

from core.db.ids import new_uuid7

models.TextField.register_lookup(Length)
models.BinaryField.register_lookup(Length)

MAX_BODY_BYTES = 1_048_576
MAX_ISSUER = 1024
MAX_SUBJECT = 255
MAX_PATH = 2048
DIGEST = r"^[0-9a-f]{64}$"


class IdempotencyRecord(models.Model):
    id = models.UUIDField(primary_key=True, default=new_uuid7, editable=False)
    issuer = models.TextField()
    subject = models.TextField()
    method = models.TextField()
    path = models.TextField()
    key_sha256 = models.TextField()
    body_sha256 = models.TextField()
    status = models.SmallIntegerField()
    content_type = models.TextField()
    body = models.BinaryField()
    location = models.TextField(null=True)  # noqa: DJ001 - absent unless the response set it
    etag = models.TextField(null=True)  # noqa: DJ001 - absent unless the response set it
    job_id = models.TextField(null=True)  # noqa: DJ001 - absent unless the response set it
    created_at = models.DateTimeField(db_default=Now())

    class Meta:
        db_table = "idempotency_record"
        constraints = [
            models.UniqueConstraint(
                fields=["issuer", "subject", "method", "path", "key_sha256"],
                name="idempotency_record_scope_unique",
            ),
            models.CheckConstraint(
                name="idempotency_record_method_post", condition=Q(method="POST")
            ),
            models.CheckConstraint(
                name="idempotency_record_status_stored",
                condition=Q(status__gte=200, status__lte=299) | Q(status__gte=400, status__lte=499),
            ),
            models.CheckConstraint(
                name="idempotency_record_digests_valid",
                condition=Q(key_sha256__regex=DIGEST, body_sha256__regex=DIGEST),
            ),
            models.CheckConstraint(
                name="idempotency_record_scope_bounded",
                condition=Q(
                    issuer__length__gte=1,
                    issuer__length__lte=MAX_ISSUER,
                    subject__length__gte=1,
                    subject__length__lte=MAX_SUBJECT,
                    path__length__gte=1,
                    path__length__lte=MAX_PATH,
                    path__startswith="/",
                ),
            ),
            models.CheckConstraint(
                name="idempotency_record_body_bounded",
                condition=Q(body__length__lte=MAX_BODY_BYTES),
            ),
        ]
        indexes = [models.Index(fields=["created_at"], name="idempotency_record_created")]

    def __str__(self) -> str:
        return f"{self.method} {self.path} {self.status}"
