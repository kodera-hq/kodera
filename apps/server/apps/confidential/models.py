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


class KeyBackupArchive(StoredModel):
    organisation = models.ForeignKey("orgs.Organisation", on_delete=models.RESTRICT)
    membership = models.OneToOneField("orgs.Membership", on_delete=models.RESTRICT)
    source_device = models.ForeignKey("e2ee.Device", on_delete=models.RESTRICT)
    backup_epoch = models.BigIntegerField()
    kdf_kind = models.TextField()
    iterations = models.IntegerField()
    capsule_sha256 = models.TextField()
    capsule = models.BinaryField(null=True)
    discarded_at = models.DateTimeField(null=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(backup_epoch__gte=1),
                name="key_backup_epoch_positive",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(kdf_kind="recovery-key", iterations=0)
                    | models.Q(
                        kdf_kind="passphrase",
                        iterations__gte=600_000,
                        iterations__lte=2_000_000,
                    )
                ),
                name="key_backup_kdf_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(capsule_sha256__regex=r"^[0-9a-f]{64}$"),
                name="key_backup_sha256_hex",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(capsule__isnull=False, discarded_at__isnull=True)
                    | models.Q(capsule__isnull=True, discarded_at__isnull=False)
                ),
                name="key_backup_discard_state",
            ),
        ]
