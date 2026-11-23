"""Public acceptance evidence only; no MLS group secret is admitted here."""

from django.db import models

from core.db.models import StoredModel


class MlsRoomEpoch(StoredModel):
    room = models.ForeignKey("e2ee.Room", on_delete=models.RESTRICT)
    epoch = models.BigIntegerField()
    commit_sequence = models.BigIntegerField()
    commit_digest = models.TextField()
    device_ids = models.JSONField(default=list)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["room", "epoch"], name="mls_room_epoch_unique"),
            models.CheckConstraint(
                condition=models.Q(epoch__gte=0, commit_sequence__gte=0),
                name="mls_epoch_nonnegative",
            ),
        ]


class DeviceVerificationBundle(StoredModel):
    device = models.OneToOneField("e2ee.Device", on_delete=models.RESTRICT)
    revision = models.BigIntegerField()
    public_bundle = models.JSONField()

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(revision__gte=1), name="verification_revision_positive"
            ),
        ]
