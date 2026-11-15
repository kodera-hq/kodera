"""Tenant-bound public device keys and opaque encrypted transport objects."""

from django.db import models
from django.db.models.functions import Length

from core.db.models import StoredModel

models.BinaryField.register_lookup(Length)


class Device(StoredModel):
    organisation = models.ForeignKey("orgs.Organisation", on_delete=models.RESTRICT)
    membership = models.ForeignKey("orgs.Membership", on_delete=models.RESTRICT)
    identity = models.ForeignKey("identity.Identity", on_delete=models.RESTRICT)
    signing_key = models.BinaryField()
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(signing_key__length=32), name="e2ee_device_key_size"
            ),
            models.UniqueConstraint(
                fields=["organisation", "signing_key"], name="e2ee_device_key_unique"
            ),
        ]


class Room(StoredModel):
    organisation = models.ForeignKey("orgs.Organisation", on_delete=models.RESTRICT)
    channel = models.OneToOneField("workspaces.Channel", on_delete=models.RESTRICT)
    algorithm = models.TextField()
    epoch = models.BigIntegerField(default=0)
    head_sequence = models.BigIntegerField(default=0)
    rekey_required = models.BooleanField(default=False)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(algorithm__in=["io.kodera.mls.v1", "m.megolm.v1.aes-sha2"]),
                name="e2ee_room_algorithm",
            ),
            models.CheckConstraint(condition=models.Q(epoch__gte=0), name="e2ee_room_epoch"),
            models.CheckConstraint(
                condition=models.Q(head_sequence__gte=0), name="e2ee_room_sequence"
            ),
        ]


class Participant(StoredModel):
    organisation = models.ForeignKey("orgs.Organisation", on_delete=models.RESTRICT)
    room = models.ForeignKey(Room, on_delete=models.RESTRICT)
    device = models.ForeignKey(Device, on_delete=models.RESTRICT)
    joined_epoch = models.BigIntegerField()
    left_epoch = models.BigIntegerField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["room", "device"], name="e2ee_participant_unique"),
            models.CheckConstraint(
                condition=models.Q(joined_epoch__gte=0), name="e2ee_joined_epoch"
            ),
            models.CheckConstraint(
                condition=models.Q(left_epoch__isnull=True)
                | models.Q(left_epoch__gt=models.F("joined_epoch")),
                name="e2ee_left_epoch",
            ),
        ]


class KeyPackage(StoredModel):
    organisation = models.ForeignKey("orgs.Organisation", on_delete=models.RESTRICT)
    device = models.ForeignKey(Device, on_delete=models.RESTRICT, related_name="packages")
    reference = models.BinaryField()
    package = models.BinaryField(null=True)
    discarded_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField()
    claimed_at = models.DateTimeField(null=True, blank=True)
    claimed_for = models.ForeignKey(Room, on_delete=models.RESTRICT, null=True, blank=True)
    claimed_by = models.ForeignKey(
        Device, on_delete=models.RESTRICT, null=True, blank=True, related_name="claimed_packages"
    )
    claimed_epoch = models.BigIntegerField(null=True, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(reference__length=32), name="e2ee_package_reference_size"
            ),
            models.CheckConstraint(
                condition=models.Q(
                    package__isnull=False,
                    package__length__range=(1, 16384),
                    discarded_at__isnull=True,
                )
                | models.Q(package__isnull=True, discarded_at__isnull=False),
                name="e2ee_package_size",
            ),
            models.CheckConstraint(
                condition=models.Q(expires_at__gt=models.F("created_at")),
                name="e2ee_package_expiry",
            ),
            models.UniqueConstraint(fields=["device", "reference"], name="e2ee_package_unique"),
            models.CheckConstraint(
                condition=models.Q(
                    claimed_at__isnull=True,
                    claimed_for__isnull=True,
                    claimed_by__isnull=True,
                    claimed_epoch__isnull=True,
                )
                | models.Q(
                    claimed_at__isnull=False,
                    claimed_for__isnull=False,
                    claimed_by__isnull=False,
                    claimed_epoch__isnull=False,
                    claimed_epoch__gte=0,
                ),
                name="e2ee_package_claim_pair",
            ),
        ]


class Envelope(StoredModel):
    organisation = models.ForeignKey("orgs.Organisation", on_delete=models.RESTRICT)
    room = models.ForeignKey(Room, on_delete=models.RESTRICT)
    sender = models.ForeignKey(Device, on_delete=models.RESTRICT, related_name="sent_envelopes")
    recipient = models.ForeignKey(
        Device, on_delete=models.RESTRICT, null=True, blank=True, related_name="received_welcomes"
    )
    sequence = models.BigIntegerField()
    epoch = models.BigIntegerField()
    kind = models.TextField()
    ciphertext = models.BinaryField()
    signature = models.BinaryField()

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["room", "sequence"], name="e2ee_envelope_sequence_unique"
            ),
            models.UniqueConstraint(
                fields=["room", "sender", "kind", "signature", "recipient"],
                nulls_distinct=False,
                name="e2ee_envelope_request_unique",
            ),
            models.CheckConstraint(
                condition=models.Q(sequence__gte=1, epoch__gte=0), name="e2ee_envelope_counters"
            ),
            models.CheckConstraint(
                condition=models.Q(ciphertext__length__range=(16, 262144)),
                name="e2ee_envelope_size",
            ),
            models.CheckConstraint(
                condition=models.Q(signature__length=64), name="e2ee_envelope_signature_size"
            ),
            models.CheckConstraint(
                condition=models.Q(kind="welcome", recipient__isnull=False)
                | models.Q(kind__in=["commit", "application"], recipient__isnull=True),
                name="e2ee_envelope_recipient_kind",
            ),
        ]
