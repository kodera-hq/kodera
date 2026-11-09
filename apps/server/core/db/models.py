"""Shared stored timestamps and retained deletion pair; no business save hooks."""

from django.db import models
from django.db.models.functions import Length

from core.db.ids import new_uuid7

models.TextField.register_lookup(Length)


class StoredModel(models.Model):
    id = models.UUIDField(primary_key=True, default=new_uuid7, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class RetainedModel(StoredModel):
    deleted_at = models.DateTimeField(null=True, blank=True)
    purge_after = models.DateTimeField(null=True, blank=True)

    class Meta:
        abstract = True
        constraints = [
            models.CheckConstraint(
                name="%(class)s_deletion_valid",
                condition=(
                    models.Q(deleted_at__isnull=True, purge_after__isnull=True)
                    | models.Q(
                        deleted_at__isnull=False,
                        purge_after__isnull=False,
                        purge_after__gt=models.F("deleted_at"),
                    )
                ),
            ),
        ]
