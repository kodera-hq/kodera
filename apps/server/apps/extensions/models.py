"""Durable scoped work and consent references; app signing secrets never enter the database."""

from django.db import models
from django.db.models import F, Q

from core.db.ids import new_uuid7
from core.db.models import StoredModel

from .expiry import delivery_expiry as delivery_expiry


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
        app_label = "extensions"
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
        app_label = "extensions"
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
        app_label = "extensions"
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
        app_label = "extensions"
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
    document = models.ForeignKey("docs.Document", on_delete=models.RESTRICT, null=True)
    channel = models.ForeignKey("workspaces.Channel", on_delete=models.RESTRICT, null=True)
    matrix_txn_id = models.TextField(null=True)  # noqa: DJ001 - absent on native document imports
    matrix_event_id = models.TextField(null=True)  # noqa: DJ001 - absent until Matrix replay succeeds
    replay_state = models.TextField(default="complete")
    thread_parent_key = models.TextField(null=True)  # noqa: DJ001 - absent on root messages and docs
    replay_payload = models.JSONField(null=True)
    collection = models.ForeignKey("docs.Collection", on_delete=models.RESTRICT, null=True)
    batch = models.ForeignKey(ImportBatch, on_delete=models.RESTRICT)

    class Meta:
        app_label = "extensions"
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "source", "external_key"], name="extension_import_object_once"
            ),
            models.CheckConstraint(
                name="extension_import_object_target",
                condition=(Q(document__isnull=False, channel__isnull=True))
                | (Q(document__isnull=True, channel__isnull=False)),
            ),
            models.CheckConstraint(
                name="extension_import_object_replay_state",
                condition=(
                    Q(
                        replay_state="complete",
                        document__isnull=False,
                        channel__isnull=True,
                        replay_payload__isnull=True,
                    )
                    | Q(
                        replay_state="queued_matrix",
                        document__isnull=True,
                        channel__isnull=False,
                        matrix_txn_id__isnull=False,
                        matrix_event_id__isnull=True,
                        replay_payload__isnull=False,
                    )
                    | Q(
                        replay_state="replayed",
                        document__isnull=True,
                        channel__isnull=False,
                        matrix_txn_id__isnull=False,
                        matrix_event_id__isnull=False,
                        replay_payload__isnull=True,
                    )
                    | Q(
                        replay_state="obsolete",
                        document__isnull=True,
                        channel__isnull=False,
                        replay_payload__isnull=True,
                    )
                ),
            ),
        ]
        indexes = [
            models.Index(fields=["replay_state", "created_at"], name="extension_import_replay_idx"),
        ]


class CoexistenceBridge(StoredModel):
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.RESTRICT)
    channel = models.ForeignKey("workspaces.Channel", on_delete=models.RESTRICT)
    creator = models.ForeignKey("orgs.Membership", on_delete=models.RESTRICT)
    source = models.TextField()
    external_workspace_id = models.TextField()
    external_channel_id = models.TextField()
    outbound_endpoint = models.TextField()
    sealed_signing_secret = models.BinaryField()
    revoked_at = models.DateTimeField(null=True)

    class Meta:
        app_label = "extensions"
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "source", "external_workspace_id", "external_channel_id"],
                condition=Q(revoked_at__isnull=True),
                name="extension_coexistence_ext_pair_active_once",
            ),
            models.UniqueConstraint(
                fields=["workspace", "channel", "source"],
                condition=Q(revoked_at__isnull=True),
                name="extension_coexistence_channel_active_once",
            ),
            models.CheckConstraint(
                name="extension_coexistence_source",
                condition=Q(source__in=("slack", "discord")),
            ),
            models.CheckConstraint(
                name="extension_coexistence_ext_ids",
                condition=Q(external_workspace_id__regex=r"^[A-Za-z0-9_.-]{1,128}$")
                & Q(external_channel_id__regex=r"^[A-Za-z0-9_.-]{1,128}$"),
            ),
        ]


class CoexistenceReplayGuard(StoredModel):
    bridge = models.ForeignKey(CoexistenceBridge, on_delete=models.RESTRICT)
    external_event_id = models.TextField()
    event_sha256 = models.TextField()
    direction = models.TextField()
    state = models.TextField(default="queued")
    lease_id = models.UUIDField(null=True)
    lease_expires_at = models.DateTimeField(null=True)
    attempts = models.IntegerField(default=0)
    matrix_txn_id = models.TextField(null=True)  # noqa: DJ001 - absent on outbound events
    matrix_event_id = models.TextField(null=True)  # noqa: DJ001 - populated on Matrix delivery/origin
    sanitized_payload = models.JSONField(null=True)
    expires_at = models.DateTimeField(default=delivery_expiry)

    class Meta:
        app_label = "extensions"
        constraints = [
            models.UniqueConstraint(
                fields=["bridge", "external_event_id"], name="extension_coexistence_event_once"
            ),
            models.CheckConstraint(
                name="extension_coexistence_direction",
                condition=Q(direction__in=("inbound", "outbound")),
            ),
            models.CheckConstraint(
                name="extension_coexistence_digest",
                condition=Q(event_sha256__regex=r"^[a-f0-9]{64}$"),
            ),
            models.CheckConstraint(
                name="extension_coexistence_state",
                condition=Q(
                    state__in=("queued", "in_flight", "delivered", "retryable_failed", "obsolete")
                ),
            ),
            models.CheckConstraint(
                name="extension_coexistence_attempts",
                condition=Q(attempts__gte=0, attempts__lte=8),
            ),
            models.CheckConstraint(
                name="extension_coexistence_lease",
                condition=Q(
                    state="in_flight", lease_id__isnull=False, lease_expires_at__isnull=False
                )
                | ~Q(state="in_flight") & Q(lease_id__isnull=True, lease_expires_at__isnull=True),
            ),
        ]
        indexes = [
            models.Index(fields=["expires_at"], name="extension_coexist_exp_idx"),
            models.Index(
                fields=["bridge", "direction", "event_sha256"], name="extension_coexist_hash_idx"
            ),
            models.Index(
                fields=["direction", "state", "created_at"], name="extension_coexist_due_idx"
            ),
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
        app_label = "extensions"
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
        app_label = "extensions"
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
        app_label = "extensions"
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

    class Meta:
        app_label = "extensions"

    def __str__(self) -> str:
        return f"extension cutoff {self.organisation_id}"


class ErasureAdmission(models.Model):
    """Immutable local admission bound to the authoritative Core erasure inventory."""

    erasure_id = models.UUIDField(primary_key=True)
    organisation_id = models.UUIDField(unique=True)
    cutoff_at = models.DateTimeField()
    inventory_sha256 = models.TextField()

    class Meta:
        app_label = "extensions"
        constraints = [
            models.CheckConstraint(
                name="extension_erasure_inventory_digest",
                condition=Q(inventory_sha256__regex=r"^[a-f0-9]{64}$"),
            )
        ]

    def __str__(self) -> str:
        return f"extension erasure admission {self.erasure_id}"


class ExtensionMarketplaceListing(StoredModel):
    """Published free or web-only Stripe Connect extension listing scoped to a workspace."""

    organisation = models.ForeignKey("orgs.Organisation", on_delete=models.RESTRICT)
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.RESTRICT)
    creator = models.ForeignKey("orgs.Membership", on_delete=models.RESTRICT)
    slug = models.TextField()
    title = models.TextField()
    summary = models.TextField()
    manifest = models.JSONField()
    pricing_mode = models.TextField(default="free")
    price_excl_vat_minor = models.BigIntegerField(default=0)
    currency = models.TextField(default="EUR")
    seller_connect_account_id = models.TextField(null=True)  # noqa: DJ001 - absent on free listings
    published_at = models.DateTimeField(null=True)
    revoked_at = models.DateTimeField(null=True)

    class Meta:
        app_label = "extensions"
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "slug"],
                condition=Q(revoked_at__isnull=True),
                name="extension_marketplace_slug_active_once",
            ),
            models.CheckConstraint(
                name="extension_marketplace_slug_shape",
                condition=Q(slug__regex=r"^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$"),
            ),
            models.CheckConstraint(
                name="extension_marketplace_pricing_mode",
                condition=Q(pricing_mode__in=("free", "one_time")),
            ),
            models.CheckConstraint(
                name="extension_marketplace_currency",
                condition=Q(currency="EUR"),
            ),
            models.CheckConstraint(
                name="extension_marketplace_pricing_consistency",
                condition=(
                    Q(
                        pricing_mode="free",
                        price_excl_vat_minor=0,
                        seller_connect_account_id__isnull=True,
                    )
                    | Q(
                        pricing_mode="one_time",
                        price_excl_vat_minor__gt=0,
                        seller_connect_account_id__regex=r"^acct_[A-Za-z0-9_]+$",
                    )
                ),
            ),
        ]


class MarketplaceEntitlement(StoredModel):
    """Buyer entitlement and optional installed extension binding for a marketplace listing."""

    organisation = models.ForeignKey("orgs.Organisation", on_delete=models.RESTRICT)
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.RESTRICT)
    buyer_membership = models.ForeignKey("orgs.Membership", on_delete=models.RESTRICT)
    listing = models.ForeignKey(ExtensionMarketplaceListing, on_delete=models.RESTRICT)
    installation = models.OneToOneField(Installation, on_delete=models.RESTRICT, null=True)
    state = models.TextField(default="pending")
    checkout_ref = models.TextField(null=True)  # noqa: DJ001 - absent on free grants
    checkout_url = models.TextField(null=True)  # noqa: DJ001 - absent on free grants
    payment_intent_id = models.TextField(null=True)  # noqa: DJ001 - populated on Stripe settlement
    gross_excl_vat_minor = models.BigIntegerField(default=0)
    vat_amount_minor = models.BigIntegerField(default=0)
    total_incl_vat_minor = models.BigIntegerField(default=0)
    application_fee_amount_minor = models.BigIntegerField(default=0)
    sealed_signing_secret = models.BinaryField(default=b"")
    idempotency_key = models.TextField()
    request_sha256 = models.TextField()
    revoked_at = models.DateTimeField(null=True)

    class Meta:
        app_label = "extensions"
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "listing"],
                condition=Q(state="active"),
                name="extension_marketplace_active_grant_once",
            ),
            models.UniqueConstraint(
                fields=["workspace", "idempotency_key"],
                name="extension_marketplace_idem_once",
            ),
            models.CheckConstraint(
                name="extension_marketplace_entitlement_state",
                condition=Q(state__in=("pending", "active", "revoked", "refunded")),
            ),
            models.CheckConstraint(
                name="extension_marketplace_req_digest",
                condition=Q(request_sha256__regex=r"^[a-f0-9]{64}$"),
            ),
        ]


class WidgetActionReceipt(StoredModel):
    """Idempotency and delivery evidence for interactive channel widget actions."""

    organisation = models.ForeignKey("orgs.Organisation", on_delete=models.RESTRICT)
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.RESTRICT)
    channel = models.ForeignKey("workspaces.Channel", on_delete=models.RESTRICT)
    installation = models.ForeignKey(Installation, on_delete=models.RESTRICT)
    actor_membership = models.ForeignKey("orgs.Membership", on_delete=models.RESTRICT)
    widget_id = models.TextField()
    action_id = models.TextField()
    idempotency_key = models.TextField()
    request_sha256 = models.TextField()
    state = models.TextField(default="in_flight")
    response_status = models.IntegerField(null=True)
    response_card = models.JSONField(null=True)
    expires_at = models.DateTimeField(default=delivery_expiry)

    class Meta:
        app_label = "extensions"
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "channel", "widget_id", "idempotency_key"],
                name="extension_widget_action_idem_once",
            ),
            models.CheckConstraint(
                name="extension_widget_action_state",
                condition=Q(state__in=("in_flight", "delivered", "refused", "failed")),
            ),
            models.CheckConstraint(
                name="extension_widget_action_digest",
                condition=Q(request_sha256__regex=r"^[a-f0-9]{64}$"),
            ),
            models.CheckConstraint(
                name="extension_widget_action_ids",
                condition=Q(widget_id__regex=r"^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$")
                & Q(action_id__regex=r"^[a-z0-9][a-z0-9_-]{0,63}$"),
            ),
        ]
        indexes = [
            models.Index(fields=["expires_at"], name="extension_widget_act_exp_idx"),
        ]
