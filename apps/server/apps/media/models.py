"""Organisation-scoped upload sessions; object keys are derived from immutable identifiers."""

from django.db import models

from core.db.models import StoredModel


class Attachment(StoredModel):
    organisation = models.ForeignKey("orgs.Organisation", on_delete=models.RESTRICT)
    uploader = models.ForeignKey("orgs.Membership", on_delete=models.RESTRICT)
    filename = models.TextField()
    content_type = models.TextField()
    size_bytes = models.BigIntegerField()
    sha256 = models.TextField()
    upload_expires_at = models.DateTimeField()
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(size_bytes__gte=1, size_bytes__lte=26214400),
                name="media_attachment_size_bound",
            ),
            models.CheckConstraint(
                condition=models.Q(sha256__regex=r"^[a-f0-9]{64}$"),
                name="media_attachment_checksum_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(
                    content_type__in=[
                        "image/jpeg",
                        "image/png",
                        "image/webp",
                        "image/gif",
                        "application/pdf",
                        "text/plain",
                        "application/octet-stream",
                    ]
                ),
                name="media_attachment_mime_valid",
            ),
        ]
