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


class PrivacyErasure(StoredModel):
    """Durable cutoff and aggregate-only progress; detached from erased customer rows."""

    organisation_reference = models.UUIDField(unique=True)
    instruction_ref = models.TextField()
    instruction_sha256 = models.TextField()
    cutoff_at = models.DateTimeField()
    purge_not_before = models.DateTimeField()
    inventory = models.JSONField(default=dict)
    inventory_sha256 = models.TextField()
    status = models.TextField(default="cutoff")
    core_purged_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    counts = models.JSONField(default=dict)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(status__in=["cutoff", "core_purged", "complete"]),
                name="erasure_status",
            ),
            models.CheckConstraint(
                condition=models.Q(instruction_ref__regex=r"^[A-Z]{2,8}-[0-9]{1,8}$"),
                name="erasure_instruction",
            ),
            models.CheckConstraint(
                condition=models.Q(instruction_sha256__regex=r"^[0-9a-f]{64}$"),
                name="erasure_instruction_digest",
            ),
        ]


class ErasureReceipt(StoredModel):
    erasure = models.ForeignKey(PrivacyErasure, on_delete=models.RESTRICT)
    domain = models.TextField()
    cutoff_at = models.DateTimeField()
    evidence_sha256 = models.TextField()
    adapter_revision = models.TextField()
    verified_at = models.DateTimeField()

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["erasure", "domain"], name="erasure_domain_receipt"),
            models.CheckConstraint(
                condition=models.Q(
                    domain__in=[
                        "matrix",
                        "objects",
                        "identity_provider",
                        "private_exports",
                        "external_extension_receivers",
                    ]
                ),
                name="erasure_domain",
            ),
            models.CheckConstraint(
                condition=models.Q(evidence_sha256__regex=r"^[0-9a-f]{64}$"),
                name="erasure_receipt_digest",
            ),
        ]


class AccountErasure(StoredModel):
    """Detached customer-person cutoff; workspace-owned content is never selected."""

    user_reference = models.UUIDField(unique=True)
    requester_identity_reference = models.UUIDField()
    instruction_ref = models.TextField()
    instruction_sha256 = models.TextField()
    cutoff_at = models.DateTimeField()
    purge_not_before = models.DateTimeField()
    inventory = models.JSONField()
    inventory_sha256 = models.TextField()
    status = models.TextField(default="cutoff")
    protocol_emitted_at = models.DateTimeField(null=True, blank=True)
    core_purged_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    counts = models.JSONField(default=dict)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(status__in=["cutoff", "core_purged", "complete"]),
                name="account_erasure_status",
            ),
            models.CheckConstraint(
                condition=models.Q(instruction_ref__regex=r"^[A-Z]{2,8}-[0-9]{1,8}$"),
                name="account_erasure_instruction",
            ),
            models.CheckConstraint(
                condition=models.Q(instruction_sha256__regex=r"^[0-9a-f]{64}$"),
                name="account_erasure_digest",
            ),
        ]


class AccountErasureReceipt(StoredModel):
    """Person-scoped receipt; cannot substitute an organisation-scoped export proof."""

    erasure = models.ForeignKey(AccountErasure, on_delete=models.RESTRICT)
    user_reference = models.UUIDField()
    inventory_sha256 = models.TextField()
    domain = models.TextField()
    cutoff_at = models.DateTimeField()
    evidence_sha256 = models.TextField()
    adapter_revision = models.TextField()
    verified_at = models.DateTimeField()

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["erasure", "domain"], name="account_erasure_receipt_unique"
            ),
            models.CheckConstraint(
                condition=models.Q(
                    domain__in=[
                        "matrix_accounts",
                        "identity_provider_accounts",
                        "private_exports",
                        "account_message_outbox",
                        "account_extension_subjects",
                    ]
                ),
                name="account_erasure_receipt_domain",
            ),
            models.CheckConstraint(
                condition=models.Q(evidence_sha256__regex=r"^[0-9a-f]{64}$"),
                name="account_erasure_receipt_digest",
            ),
        ]
